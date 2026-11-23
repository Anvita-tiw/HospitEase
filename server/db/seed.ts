import bcrypt from 'bcryptjs';
import { db } from './database.ts';
import { buildTrainingDatasetFromDb } from '../ml/trainingData.ts';
import { loadModelArtifact, saveModelArtifact, trainAndEvaluateModels } from '../ml/models.ts';
import { predictionService } from '../ml/service.ts';
import { toISTParts } from '../utils/time.ts';
import { deriveQueueLevel } from '../utils/validation.ts';
import type { OpdTimingsConfig } from '../types.ts';

function seededRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface HospitalSeedEntry {
  name: string;
  address: string;
  city: string;
  contact: string;
  type: string;
  loadFactor: number;
  departments: Array<{ name: string; timings: OpdTimingsConfig; baseWait: number }>;
  wards: Array<{ ward_type: string; total_beds: number; baseAvailRatio: number }>;
}

const INITIAL_HOSPITALS: HospitalSeedEntry[] = [
  {
    name: 'Maharaja Yeshwantrao Hospital (MYH)',
    address: 'MYH Campus, A.B. Road, Near CRP Lines, Indore, MP 452001',
    city: 'Indore',
    contact: '+91-731-2527301',
    type: 'Government',
    loadFactor: 1.55,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 42,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:00 PM · 05:00 PM–08:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:30' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 48,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 36,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:30 PM–08:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:30', end: '20:30' },
          ],
        },
      },
      {
        name: 'ENT',
        baseWait: 32,
        timings: {
          label: 'Mon–Sat 09:00 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 420, baseAvailRatio: 0.08 },
      { ward_type: 'ICU', total_beds: 48, baseAvailRatio: 0.06 },
      { ward_type: 'Maternity Ward', total_beds: 110, baseAvailRatio: 0.14 },
      { ward_type: 'Pediatric Ward', total_beds: 85, baseAvailRatio: 0.18 },
    ],
  },
  {
    name: 'Choithram Hospital & Research Centre',
    address: '14 Manik Bagh Road, Indore, MP 452014',
    city: 'Indore',
    contact: '+91-731-2362491',
    type: 'Trust / Charitable',
    loadFactor: 1.0,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 24,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–08:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:30' },
          ],
        },
      },
      {
        name: 'Cardiology',
        baseWait: 30,
        timings: {
          label: 'Mon–Sat 10:00 AM–02:00 PM · 05:30 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:30', end: '20:00' },
          ],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 20,
        timings: {
          label: 'Daily 09:30 AM–01:30 PM · 05:30 PM–08:30 PM',
          sessions: [
            { days: [0, 1, 2, 3, 4, 5, 6], start: '09:30', end: '13:30' },
            { days: [0, 1, 2, 3, 4, 5, 6], start: '17:30', end: '20:30' },
          ],
        },
      },
      {
        name: 'Dermatology',
        baseWait: 18,
        timings: {
          label: 'Mon–Sat 10:00 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 180, baseAvailRatio: 0.34 },
      { ward_type: 'ICU', total_beds: 32, baseAvailRatio: 0.18 },
      { ward_type: 'Pediatric Ward', total_beds: 45, baseAvailRatio: 0.38 },
    ],
  },
  {
    name: 'Bombay Hospital Indore',
    address: 'Eastern Ring Road, Vijay Nagar, Indore, MP 452010',
    city: 'Indore',
    contact: '+91-731-2558866',
    type: 'Private',
    loadFactor: 0.85,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 16,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–08:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:30' },
          ],
        },
      },
      {
        name: 'Cardiology',
        baseWait: 22,
        timings: {
          label: 'Mon–Sat 09:30 AM–02:30 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '14:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 19,
        timings: {
          label: 'Mon–Sat 10:00 AM–02:00 PM · 06:00 PM–08:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '18:00', end: '20:30' },
          ],
        },
      },
      {
        name: 'Ophthalmology',
        baseWait: 14,
        timings: {
          label: 'Mon–Sat 09:30 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 150, baseAvailRatio: 0.42 },
      { ward_type: 'ICU', total_beds: 40, baseAvailRatio: 0.24 },
      { ward_type: 'Observation / Daycare', total_beds: 35, baseAvailRatio: 0.48 },
    ],
  },
  {
    name: 'Medanta Super Specialty Hospital',
    address: 'Plot No. 8, PU4, Scheme No. 54, Vijay Nagar, Indore, MP 452010',
    city: 'Indore',
    contact: '+91-731-4747000',
    type: 'Private',
    loadFactor: 0.9,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 15,
        timings: {
          label: 'Daily 08:30 AM–08:30 PM',
          sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '08:30', end: '20:30' }],
        },
      },
      {
        name: 'Cardiology',
        baseWait: 21,
        timings: {
          label: 'Mon–Sat 09:00 AM–07:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:30' }],
        },
      },
      {
        name: 'Gynecology',
        baseWait: 23,
        timings: {
          label: 'Mon–Sat 09:30 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 140, baseAvailRatio: 0.36 },
      { ward_type: 'ICU', total_beds: 45, baseAvailRatio: 0.21 },
      { ward_type: 'Maternity Ward', total_beds: 30, baseAvailRatio: 0.33 },
    ],
  },
  {
    name: 'Sri Aurobindo Institute of Medical Sciences (SAIMS)',
    address: 'Indore–Ujjain State Highway, Bhawrasla, Indore, MP 453555',
    city: 'Indore',
    contact: '+91-731-4231000',
    type: 'Teaching',
    loadFactor: 1.25,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 33,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:30 PM · 04:30 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '16:30', end: '19:30' },
          ],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 28,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 35,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'ENT',
        baseWait: 25,
        timings: {
          label: 'Mon–Sat 09:00 AM–01:30 PM · 05:00 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '19:30' },
          ],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 320, baseAvailRatio: 0.22 },
      { ward_type: 'ICU', total_beds: 36, baseAvailRatio: 0.14 },
      { ward_type: 'Pediatric Ward', total_beds: 60, baseAvailRatio: 0.29 },
    ],
  },
  {
    name: 'District Hospital Indore (PCMH)',
    address: 'Dhar Road, Near Malharganj, Indore, MP 452002',
    city: 'Indore',
    contact: '+91-731-2342110',
    type: 'Government',
    loadFactor: 1.35,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 38,
        timings: {
          label: 'Mon–Sat 08:30 AM–01:30 PM · 05:00 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '13:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '19:30' },
          ],
        },
      },
      {
        name: 'Gynecology',
        baseWait: 40,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 31,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 160, baseAvailRatio: 0.15 },
      { ward_type: 'Maternity Ward', total_beds: 70, baseAvailRatio: 0.11 },
      { ward_type: 'ICU', total_beds: 18, baseAvailRatio: 0.05 },
    ],
  },
  {
    name: 'CARE CHL Hospitals, Indore',
    address: 'AB Road, Near LIG Square, Indore, MP 452008',
    city: 'Indore',
    contact: '+91-731-4774444',
    type: 'Private',
    loadFactor: 0.95,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 18,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–08:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:30' },
          ],
        },
      },
      {
        name: 'Cardiology',
        baseWait: 25,
        timings: {
          label: 'Mon–Sat 09:30 AM–02:30 PM · 05:30 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '14:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:30', end: '20:00' },
          ],
        },
      },
      {
        name: 'Neurology',
        baseWait: 27,
        timings: {
          label: 'Mon–Sat 10:00 AM–02:00 PM · 05:30 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:30', end: '19:30' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 20,
        timings: {
          label: 'Mon–Sat 10:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '14:00' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 145, baseAvailRatio: 0.37 },
      { ward_type: 'ICU', total_beds: 38, baseAvailRatio: 0.22 },
      { ward_type: 'Observation / Daycare', total_beds: 28, baseAvailRatio: 0.45 },
    ],
  },
  {
    name: 'Apollo Hospitals, Indore',
    address: 'Scheme No. 74C, Sector D, Vijay Nagar, Indore, MP 452010',
    city: 'Indore',
    contact: '+91-731-2445566',
    type: 'Private',
    loadFactor: 0.88,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 16,
        timings: {
          label: 'Daily 08:30 AM–08:30 PM',
          sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '08:30', end: '20:30' }],
        },
      },
      {
        name: 'Cardiology',
        baseWait: 23,
        timings: {
          label: 'Mon–Sat 09:00 AM–07:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '19:00' }],
        },
      },
      {
        name: 'Gynecology',
        baseWait: 21,
        timings: {
          label: 'Mon–Sat 09:30 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 17,
        timings: {
          label: 'Daily 09:00 AM–01:30 PM · 05:30 PM–08:30 PM',
          sessions: [
            { days: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '13:30' },
            { days: [0, 1, 2, 3, 4, 5, 6], start: '17:30', end: '20:30' },
          ],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 135, baseAvailRatio: 0.39 },
      { ward_type: 'ICU', total_beds: 42, baseAvailRatio: 0.25 },
      { ward_type: 'Maternity Ward', total_beds: 26, baseAvailRatio: 0.35 },
    ],
  },
  {
    name: 'Index Medical College Hospital & Research Centre',
    address: 'Nemawar Road, NH-59A, Khudel, Indore, MP 452016',
    city: 'Indore',
    contact: '+91-731-4013600',
    type: 'Teaching',
    loadFactor: 1.2,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 30,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:30 PM · 04:30 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '16:30', end: '19:30' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 34,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Dermatology',
        baseWait: 22,
        timings: {
          label: 'Mon–Sat 09:00 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:30' }],
        },
      },
      {
        name: 'ENT',
        baseWait: 24,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 310, baseAvailRatio: 0.27 },
      { ward_type: 'ICU', total_beds: 34, baseAvailRatio: 0.16 },
      { ward_type: 'Pediatric Ward', total_beds: 54, baseAvailRatio: 0.31 },
    ],
  },
  {
    name: 'Shalby Multi-Specialty Hospital, Indore',
    address: '5 & 6, R.S. Bhandari Marg, Janjeerwala Square, Indore, MP 452003',
    city: 'Indore',
    contact: '+91-731-4777000',
    type: 'Private',
    loadFactor: 0.85,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 15,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 22,
        timings: {
          label: 'Mon–Sat 09:30 AM–02:30 PM · 05:30 PM–08:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '14:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:30', end: '20:30' },
          ],
        },
      },
      {
        name: 'Ophthalmology',
        baseWait: 13,
        timings: {
          label: 'Mon–Sat 10:00 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 120, baseAvailRatio: 0.44 },
      { ward_type: 'ICU', total_beds: 28, baseAvailRatio: 0.28 },
      { ward_type: 'Observation / Daycare', total_beds: 24, baseAvailRatio: 0.52 },
    ],
  },
  {
    name: 'AIIMS Bhopal (All India Institute of Medical Sciences)',
    address: 'Saket Nagar, Habibganj, Bhopal, MP 462020',
    city: 'Bhopal',
    contact: '+91-755-2672317',
    type: 'Government',
    loadFactor: 1.5,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 46,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:00 PM · 04:30 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '16:30', end: '19:30' },
          ],
        },
      },
      {
        name: 'Cardiology',
        baseWait: 52,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Neurology',
        baseWait: 49,
        timings: {
          label: 'Mon–Sat 09:00 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:30' }],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 38,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'ENT',
        baseWait: 34,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 520, baseAvailRatio: 0.11 },
      { ward_type: 'ICU', total_beds: 64, baseAvailRatio: 0.08 },
      { ward_type: 'Maternity Ward', total_beds: 95, baseAvailRatio: 0.16 },
      { ward_type: 'Pediatric Ward', total_beds: 90, baseAvailRatio: 0.21 },
    ],
  },
  {
    name: 'Hamidia Hospital (Gandhi Medical College)',
    address: 'Sultania Road, Royal Market, Bhopal, MP 462001',
    city: 'Bhopal',
    contact: '+91-755-2540590',
    type: 'Government',
    loadFactor: 1.48,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 44,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 45,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Gynecology',
        baseWait: 41,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Ophthalmology',
        baseWait: 30,
        timings: {
          label: 'Mon–Sat 09:00 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 460, baseAvailRatio: 0.09 },
      { ward_type: 'ICU', total_beds: 52, baseAvailRatio: 0.07 },
      { ward_type: 'Maternity Ward', total_beds: 120, baseAvailRatio: 0.13 },
    ],
  },
  {
    name: 'Bansal Hospital, Bhopal',
    address: 'C-Sector, Shahpura, Bhopal, MP 462016',
    city: 'Bhopal',
    contact: '+91-755-4086000',
    type: 'Private',
    loadFactor: 0.9,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 17,
        timings: {
          label: 'Daily 08:30 AM–08:30 PM',
          sessions: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '08:30', end: '20:30' }],
        },
      },
      {
        name: 'Cardiology',
        baseWait: 24,
        timings: {
          label: 'Mon–Sat 09:30 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Neurology',
        baseWait: 25,
        timings: {
          label: 'Mon–Sat 10:00 AM–02:00 PM · 05:30 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:30', end: '19:30' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 19,
        timings: {
          label: 'Mon–Sat 10:00 AM–02:00 PM · 05:30 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '10:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:30', end: '20:00' },
          ],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 185, baseAvailRatio: 0.4 },
      { ward_type: 'ICU', total_beds: 50, baseAvailRatio: 0.23 },
      { ward_type: 'Observation / Daycare', total_beds: 32, baseAvailRatio: 0.46 },
    ],
  },
  {
    name: 'Chirayu Medical College & Hospital',
    address: 'Bhainsakhedi, Bhopal–Indore Highway, Bairagarh, Bhopal, MP 462030',
    city: 'Bhopal',
    contact: '+91-755-2709100',
    type: 'Teaching',
    loadFactor: 1.18,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 29,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:30 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 25,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Gynecology',
        baseWait: 28,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Dermatology',
        baseWait: 21,
        timings: {
          label: 'Mon–Sat 09:30 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 360, baseAvailRatio: 0.28 },
      { ward_type: 'ICU', total_beds: 42, baseAvailRatio: 0.19 },
      { ward_type: 'Pediatric Ward', total_beds: 65, baseAvailRatio: 0.34 },
    ],
  },
  {
    name: 'Charak Bhawan District Hospital, Ujjain',
    address: 'Madhav Nagar, Agar Road, Ujjain, MP 456001',
    city: 'Ujjain',
    contact: '+91-734-2512840',
    type: 'Government',
    loadFactor: 1.38,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 37,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:00 PM · 05:00 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '19:30' },
          ],
        },
      },
      {
        name: 'Gynecology',
        baseWait: 39,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 32,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '19:30' },
          ],
        },
      },
      {
        name: 'Orthopedics',
        baseWait: 35,
        timings: {
          label: 'Mon–Sat 09:00 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 240, baseAvailRatio: 0.16 },
      { ward_type: 'Maternity Ward', total_beds: 90, baseAvailRatio: 0.14 },
      { ward_type: 'ICU', total_beds: 24, baseAvailRatio: 0.1 },
    ],
  },
  {
    name: 'R.D. Gardi Medical College (C.R. Gardi Hospital)',
    address: 'Agar Road, Surasa, Ujjain, MP 456006',
    city: 'Ujjain',
    contact: '+91-734-2538801',
    type: 'Teaching',
    loadFactor: 1.12,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 27,
        timings: {
          label: 'Mon–Sat 08:30 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'ENT',
        baseWait: 23,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 24,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '19:30' },
          ],
        },
      },
      {
        name: 'Dermatology',
        baseWait: 19,
        timings: {
          label: 'Mon–Sat 09:30 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 280, baseAvailRatio: 0.31 },
      { ward_type: 'ICU', total_beds: 30, baseAvailRatio: 0.2 },
      { ward_type: 'Pediatric Ward', total_beds: 52, baseAvailRatio: 0.36 },
    ],
  },
  {
    name: 'Mahatma Gandhi District Hospital, Dewas',
    address: 'A.B. Road, Near Sayaji Gate, Dewas, MP 455001',
    city: 'Dewas',
    contact: '+91-7272-252310',
    type: 'Government',
    loadFactor: 1.3,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 35,
        timings: {
          label: 'Mon–Sat 08:30 AM–01:30 PM · 05:00 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '08:30', end: '13:30' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '19:30' },
          ],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 29,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
      {
        name: 'Gynecology',
        baseWait: 34,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 190, baseAvailRatio: 0.19 },
      { ward_type: 'Maternity Ward', total_beds: 65, baseAvailRatio: 0.17 },
      { ward_type: 'ICU', total_beds: 20, baseAvailRatio: 0.12 },
    ],
  },
  {
    name: 'Amaltas Institute of Medical Sciences, Dewas',
    address: 'Village Bangar, Dewas–Ujjain Highway, Dewas, MP 455001',
    city: 'Dewas',
    contact: '+91-7272-227700',
    type: 'Teaching',
    loadFactor: 1.05,
    departments: [
      {
        name: 'General Medicine',
        baseWait: 25,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–08:00 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '20:00' },
          ],
        },
      },
      {
        name: 'Cardiology',
        baseWait: 28,
        timings: {
          label: 'Mon–Sat 09:30 AM–02:00 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '14:00' }],
        },
      },
      {
        name: 'Pediatrics',
        baseWait: 22,
        timings: {
          label: 'Mon–Sat 09:00 AM–02:00 PM · 05:00 PM–07:30 PM',
          sessions: [
            { days: [1, 2, 3, 4, 5, 6], start: '09:00', end: '14:00' },
            { days: [1, 2, 3, 4, 5, 6], start: '17:00', end: '19:30' },
          ],
        },
      },
      {
        name: 'ENT',
        baseWait: 20,
        timings: {
          label: 'Mon–Sat 09:30 AM–01:30 PM',
          sessions: [{ days: [1, 2, 3, 4, 5, 6], start: '09:30', end: '13:30' }],
        },
      },
    ],
    wards: [
      { ward_type: 'General Ward', total_beds: 250, baseAvailRatio: 0.35 },
      { ward_type: 'ICU', total_beds: 28, baseAvailRatio: 0.24 },
      { ward_type: 'Pediatric Ward', total_beds: 48, baseAvailRatio: 0.39 },
    ],
  },
];

function insertHospitalWithHistory(
  hosp: HospitalSeedEntry,
  nowMs: number,
  nowIso: string,
  rng: () => number,
) {
  const insertHospital = db.prepare(
    'INSERT INTO hospitals (name, address, city, contact, type, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  );
  const insertDept = db.prepare(
    'INSERT INTO departments (hospital_id, name, opd_timings, is_active) VALUES (?, ?, ?, 1)',
  );
  const insertQueue = db.prepare(
    'INSERT INTO opd_queue_records (department_id, record_time, queue_size, queue_level, data_source) VALUES (?, ?, ?, ?, ?)',
  );
  const insertWait = db.prepare(
    'INSERT INTO waiting_time_records (department_id, record_time, avg_waiting_minutes, data_source) VALUES (?, ?, ?, ?)',
  );
  const insertBed = db.prepare(
    'INSERT INTO bed_availability_records (hospital_id, ward_type, total_beds, available_beds, record_time, data_source) VALUES (?, ?, ?, ?, ?, ?)',
  );

  const hRes = insertHospital.run(hosp.name, hosp.address, hosp.city, hosp.contact, hosp.type, nowIso);
  const hospitalId = Number(hRes.lastInsertRowid);

  const deptEntries: Array<{ id: number; baseWait: number; name: string }> = [];
  for (const dept of hosp.departments) {
    const dRes = insertDept.run(hospitalId, dept.name, JSON.stringify(dept.timings));
    const departmentId = Number(dRes.lastInsertRowid);
    deptEntries.push({ id: departmentId, baseWait: dept.baseWait, name: dept.name });
  }

  // Generate 95 days of historical OPD queue, waiting-time, and ward bed records (TBD-9 >= 90 days)
  for (let dayOffset = 94; dayOffset >= 0; dayOffset--) {
    const dayBaseMs = nowMs - dayOffset * 24 * 60 * 60 * 1000;
    const dayDate = new Date(dayBaseMs);
    dayDate.setUTCHours(0, 0, 0, 0);

    const utcHours = [4, 6, 8, 12];
    for (const dept of deptEntries) {
      for (const uh of utcHours) {
        const slotDate = new Date(dayDate.getTime() + uh * 60 * 60 * 1000 + 15 * 60 * 1000);
        if (slotDate.getTime() > nowMs - 2 * 60 * 60 * 1000) continue;

        const ist = toISTParts(slotDate);
        let dowMultiplier = 1.0;
        if (ist.dayOfWeek === 1) dowMultiplier = 1.32;
        else if (ist.dayOfWeek === 2) dowMultiplier = 1.15;
        else if (ist.dayOfWeek === 6) dowMultiplier = 1.08;
        else if (ist.dayOfWeek === 0) dowMultiplier = 0.62;

        let slotMultiplier = 1.0;
        if (ist.timeSlot === 'morning') slotMultiplier = 1.12;
        else if (ist.timeSlot === 'midday') slotMultiplier = 1.28;
        else if (ist.timeSlot === 'afternoon') slotMultiplier = 0.88;
        else if (ist.timeSlot === 'evening') slotMultiplier = 0.94;

        const holidayFactor = ist.isHoliday ? 0.65 : 1.0;
        const dailyWave = Math.sin((dayOffset / 5) * Math.PI) * 6;
        const dailySurge = dayOffset % 11 === 0 ? 14 : dayOffset % 7 === 0 ? -5 : 0;
        const noise = (rng() - 0.5) * 8;
        const waitMin = Math.max(
          4,
          Math.min(
            180,
            Math.round(
              dept.baseWait * dowMultiplier * slotMultiplier * holidayFactor +
                dailyWave +
                dailySurge +
                noise,
            ),
          ),
        );
        const queueSize = Math.max(2, Math.round(waitMin * 0.72 + (rng() - 0.5) * 4));
        const recIso = slotDate.toISOString();

        insertQueue.run(dept.id, recIso, queueSize, deriveQueueLevel(waitMin), 'synthetic');
        insertWait.run(dept.id, recIso, waitMin, 'synthetic');
      }
    }

    for (const ward of hosp.wards) {
      for (const uh of [3, 12]) {
        const recDate = new Date(dayDate.getTime() + uh * 60 * 60 * 1000);
        if (recDate.getTime() > nowMs - 30 * 60 * 1000) continue;
        const ist = toISTParts(recDate);
        const dayWave = Math.sin((dayOffset / 14) * Math.PI) * 0.07;
        const dowDelta = ist.dayOfWeek === 1 ? -0.05 : ist.dayOfWeek === 0 ? 0.06 : 0;
        const noise = (rng() - 0.5) * 0.08;
        const ratio = Math.max(0.02, Math.min(0.85, ward.baseAvailRatio + dayWave + dowDelta + noise));
        const avail = Math.max(0, Math.min(ward.total_beds, Math.round(ward.total_beds * ratio)));
        insertBed.run(hospitalId, ward.ward_type, ward.total_beds, avail, recDate.toISOString(), 'synthetic');
      }
    }
  }

  return { hospitalId, deptEntries };
}

export async function ensureSeededAndTrained(): Promise<void> {
  const userCountRow = db.prepare('SELECT COUNT(*) AS cnt FROM users').get() as { cnt: number };
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  let addedHospitalsCount = 0;

  if (userCountRow.cnt === 0) {
    const adminHash = bcrypt.hashSync('Admin1234', 10);
    const patientHash = bcrypt.hashSync('Patient123', 10);

    const insertUser = db.prepare(
      'INSERT INTO users (name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const adminRes = insertUser.run('Margi Admin', 'admin@hospitease.in', adminHash, 'admin', 'active', nowIso);
    const patientRes = insertUser.run('Anvita Patient', 'patient@hospitease.in', patientHash, 'user', 'active', nowIso);
    const patient2Res = insertUser.run('Rahul Verma', 'rahul@hospitease.in', patientHash, 'user', 'active', nowIso);

    const deptIdsByHospital: Array<{ hospitalId: number; departmentId: number; name: string; baseWait: number }> = [];

    const seedTx = db.transaction(() => {
      for (const hosp of INITIAL_HOSPITALS) {
        const { hospitalId, deptEntries } = insertHospitalWithHistory(
          hosp,
          nowMs,
          nowIso,
          seededRng(hashSeed(hosp.name)),
        );
        for (const d of deptEntries) {
          deptIdsByHospital.push({ hospitalId, departmentId: d.id, name: d.name, baseWait: d.baseWait });
        }
      }

      // Make one ward on District Hospital Indore slightly outdated (> 24h) for staleness notice coverage
      db.prepare(
        `UPDATE bed_availability_records
         SET record_time = ?
         WHERE hospital_id = (SELECT hospital_id FROM hospitals WHERE name = 'District Hospital Indore (PCMH)' LIMIT 1)
           AND ward_type = 'ICU'
           AND record_time = (
             SELECT MAX(record_time) FROM bed_availability_records
             WHERE hospital_id = (SELECT hospital_id FROM hospitals WHERE name = 'District Hospital Indore (PCMH)' LIMIT 1)
               AND ward_type = 'ICU'
           )`,
      ).run(new Date(nowMs - 30 * 60 * 60 * 1000).toISOString());

      const insertCrowd = db.prepare(
        `INSERT INTO crowd_updates
         (user_id, hospital_id, department_id, queue_level, waiting_minutes, visit_time, submitted_at, validation_status, flag_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const p1 = Number(patientRes.lastInsertRowid);
      const p2 = Number(patient2Res.lastInsertRowid);
      const a1 = Number(adminRes.lastInsertRowid);

      const firstDept = deptIdsByHospital[0];
      const secondDept = deptIdsByHospital[4];
      const thirdDept = deptIdsByHospital[8];

      const minsAgo = (m: number) => new Date(nowMs - m * 60 * 1000).toISOString();

      insertCrowd.run(p1, firstDept.hospitalId, firstDept.departmentId, 'High', 55, minsAgo(25), minsAgo(12), 'Accepted', null);
      insertCrowd.run(p2, firstDept.hospitalId, firstDept.departmentId, 'High', 50, minsAgo(48), minsAgo(35), 'Accepted', null);
      insertCrowd.run(p2, secondDept.hospitalId, secondDept.departmentId, 'Medium', 26, minsAgo(30), minsAgo(18), 'Accepted', null);
      insertCrowd.run(p1, thirdDept.hospitalId, thirdDept.departmentId, 'Low', 14, minsAgo(22), minsAgo(15), 'Accepted', null);

      insertCrowd.run(
        p2,
        firstDept.hospitalId,
        firstDept.departmentId,
        'High',
        215,
        minsAgo(65),
        minsAgo(50),
        'Flagged',
        'Submitted wait (215 min) differs significantly from historical mean (42 min), exceeding 2×SD threshold.',
      );
      insertCrowd.run(
        p1,
        secondDept.hospitalId,
        secondDept.departmentId,
        'High',
        165,
        minsAgo(80),
        minsAgo(68),
        'Flagged',
        'Submitted wait (165 min) differs significantly from historical mean (24 min), exceeding 2×SD threshold.',
      );

      db.prepare(
        'INSERT INTO audit_logs (admin_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)',
      ).run(
        a1,
        'SEED_INIT',
        'system',
        `Initialized ${INITIAL_HOSPITALS.length} hospital profiles across Indore, Bhopal, Ujjain, and Dewas.`,
        nowIso,
      );
    });

    seedTx();
  } else {
    // Idempotent backfill for newly added hospitals when upgrading an existing SQLite DB
    const existingNames = new Set(
      (db.prepare('SELECT name FROM hospitals').all() as Array<{ name: string }>).map((r) => r.name),
    );
    const missingHospitals = INITIAL_HOSPITALS.filter((h) => !existingNames.has(h.name));

    if (missingHospitals.length > 0) {
      addedHospitalsCount = missingHospitals.length;
      const adminRow = db.prepare("SELECT user_id FROM users WHERE role = 'admin' ORDER BY user_id ASC LIMIT 1").get() as
        | { user_id: number }
        | undefined;
      const syncTx = db.transaction(() => {
        for (const hosp of missingHospitals) {
          insertHospitalWithHistory(hosp, nowMs, nowIso, seededRng(hashSeed(hosp.name)));
        }
        db.prepare(
          'INSERT INTO audit_logs (admin_id, action, target, details, created_at) VALUES (?, ?, ?, ?, ?)',
        ).run(
          adminRow?.user_id ?? null,
          'HOSPITAL_CATALOG_EXPANDED',
          'hospitals',
          `Added ${missingHospitals.length} hospitals (${missingHospitals.map((h) => h.city).filter((v, i, a) => a.indexOf(v) === i).join(', ')}) with 95-day baseline records.`,
          nowIso,
        );
      });
      syncTx();
    }
  }

  // Ensure an active trained model version exists and covers all hospitals in the catalog
  const activeModel = db
    .prepare("SELECT model_version FROM model_versions WHERE status = 'active' LIMIT 1")
    .get() as { model_version: string } | undefined;

  const activeHospitalCount = (
    db.prepare('SELECT COUNT(*) AS cnt FROM hospitals WHERE is_active = 1').get() as { cnt: number }
  ).cnt;
  const activeArtifact = activeModel
    ? loadModelArtifact(predictionService.getModelsDir(), activeModel.model_version)
    : null;

  if (!activeModel || !activeArtifact || addedHospitalsCount > 0 || activeArtifact.schema.hospitalIds.length < activeHospitalCount) {
    const existingCount = (
      db.prepare('SELECT COUNT(*) AS cnt FROM model_versions').get() as { cnt: number }
    ).cnt;
    const version = existingCount === 0 ? 'v1.0.0' : `v1.${existingCount}.0`;
    const { waitingSamples, bedSamples, dataProvenance } = buildTrainingDatasetFromDb();
    const artifact = trainAndEvaluateModels(waitingSamples, bedSamples, version, dataProvenance);
    saveModelArtifact(predictionService.getModelsDir(), artifact);

    db.prepare("UPDATE model_versions SET status = 'archived' WHERE status = 'active'").run();
    db.prepare(
      `INSERT OR REPLACE INTO model_versions
       (model_version, model_type, training_range, metrics, data_provenance, status, trained_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    ).run(
      artifact.model_version,
      artifact.model_type,
      artifact.training_range,
      JSON.stringify(artifact.metrics),
      artifact.data_provenance,
      artifact.trained_at,
    );

    await predictionService.loadModel(version);
  } else {
    await predictionService.loadModel(activeModel.model_version);
  }
}
