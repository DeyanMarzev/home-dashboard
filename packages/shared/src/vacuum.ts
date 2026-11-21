/**
 * What the Roborock's `get_status.state` code means (docs/03 § roborock). Codes as in
 * python-roborock's RoborockStateCode. The collector stores the code as `state` on entity
 * `vacuum`; the web app and the "not charging" warning both read it through this.
 */

/**
 * Where the robot is, for the "not charging" check:
 * - `docked`: on its dock (charging, full, emptying the bin)
 * - `busy`: doing something on its own (cleaning, heading home); fine to leave
 * - `stranded`: off its dock and not going anywhere, or a charging problem: needs a person
 * - `unknown`: a code we don't know; never warned about
 */
export type VacuumPlace = 'docked' | 'busy' | 'stranded' | 'unknown';

export interface VacuumState {
  label: string;
  place: VacuumPlace;
}

const STATES: Readonly<Record<number, VacuumState>> = {
  1: { label: 'Starting', place: 'busy' },
  2: { label: 'Off the charger', place: 'stranded' },
  3: { label: 'Idle', place: 'stranded' },
  4: { label: 'Remote control', place: 'busy' },
  5: { label: 'Cleaning', place: 'busy' },
  6: { label: 'Returning to dock', place: 'busy' },
  7: { label: 'Manual mode', place: 'busy' },
  8: { label: 'Charging', place: 'docked' },
  9: { label: 'Charging problem', place: 'stranded' },
  10: { label: 'Paused', place: 'stranded' },
  11: { label: 'Spot cleaning', place: 'busy' },
  12: { label: 'Error', place: 'stranded' },
  13: { label: 'Shutting down', place: 'stranded' },
  14: { label: 'Updating', place: 'busy' },
  15: { label: 'Docking', place: 'busy' },
  16: { label: 'Going to a spot', place: 'busy' },
  17: { label: 'Zone cleaning', place: 'busy' },
  18: { label: 'Room cleaning', place: 'busy' },
  22: { label: 'Emptying the bin', place: 'docked' },
  23: { label: 'Washing the mop', place: 'docked' },
  26: { label: 'Going to wash the mop', place: 'busy' },
  29: { label: 'Mapping', place: 'busy' },
  100: { label: 'Fully charged', place: 'docked' },
};

export function vacuumState(code: number): VacuumState {
  return STATES[code] ?? { label: `State ${code}`, place: 'unknown' };
}

/** Below this the battery is shown as low. */
export const VACUUM_LOW_BATTERY = 20;
