import { formatLondonDayMonth, TariffsPutSchema, type Tariff } from '@home/shared';
import { useState, type ReactNode } from 'react';
import { useIsAdmin, useSaveTariffs, useTariffs } from '../api/hooks.js';
import { Empty, Skeleton } from './Cards.js';

const UNIT: Record<Tariff['fuel'], string> = { electricity: 'p/kWh', gas: 'p/kWh', water: 'p/m³' };
const FUEL_NAME: Record<Tariff['fuel'], string> = {
  electricity: 'Electricity',
  gas: 'Gas',
  water: 'Water',
};

interface Draft {
  fuel: Tariff['fuel'];
  unitRatePence: string;
  standingPence: string;
  validFrom: string;
  validTo: string;
}

const toDraft = (t: Tariff): Draft => ({
  fuel: t.fuel,
  unitRatePence: String(t.unitRatePence),
  standingPence: String(t.standingPence),
  validFrom: t.validFrom,
  validTo: t.validTo ?? '',
});

const period = (t: Pick<Tariff, 'validFrom' | 'validTo'>) =>
  `${formatLondonDayMonth(new Date(`${t.validFrom}T12:00:00Z`))} ${t.validFrom.slice(0, 4)} – ${t.validTo ? `${formatLondonDayMonth(new Date(`${t.validTo}T12:00:00Z`))} ${t.validTo.slice(0, 4)}` : 'now'}`;

/**
 * Tariff table with an editor for some fuels (docs/05): electricity and gas on the Energy page,
 * water on the Water page. Saving replaces every tariff row (PUT /api/tariffs), so the rows of
 * the other fuels are sent back unchanged.
 */
export function TariffPanel({
  fuels,
  title = 'Tariff',
  id = 'tariff-h',
  note,
  empty,
}: {
  fuels: readonly Tariff['fuel'][];
  title?: string;
  id?: string;
  /** Shown under the table. */
  note?: ReactNode;
  /** Shown when none of these fuels has a rate. */
  empty: string;
}) {
  const tariffs = useTariffs();
  const isAdmin = useIsAdmin();
  const shown = (tariffs.data?.items ?? []).filter((t) => fuels.includes(t.fuel));
  const others = (tariffs.data?.items ?? []).filter((t) => !fuels.includes(t.fuel));
  const firstFuel = fuels[0] ?? 'electricity';
  const save = useSaveTariffs();
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const startEditing = () => {
    setProblem(null);
    const rows = shown.map(toDraft);
    setDrafts(
      rows.length
        ? rows
        : [
            {
              fuel: firstFuel,
              unitRatePence: '',
              standingPence: '',
              validFrom: new Date().toISOString().slice(0, 10),
              validTo: '',
            },
          ],
    );
  };
  const update = (i: number, patch: Partial<Draft>) =>
    setDrafts((d) => d && d.map((row, j) => (j === i ? { ...row, ...patch } : row)));

  const submit = () => {
    if (!drafts) return;
    const items = [
      ...drafts.map((d) => ({
        fuel: d.fuel,
        unitRatePence: Number(d.unitRatePence),
        standingPence: d.standingPence === '' ? 0 : Number(d.standingPence),
        validFrom: d.validFrom,
        validTo: d.validTo === '' ? null : d.validTo,
      })),
      // Not shown here: kept exactly as they are.
      ...others.map(({ fuel, unitRatePence, standingPence, validFrom, validTo }) => ({
        fuel,
        unitRatePence,
        standingPence,
        validFrom,
        validTo,
      })),
    ];
    const checked = TariffsPutSchema.safeParse({ items });
    if (!checked.success) {
      setProblem(checked.error.issues.map((i) => i.message).join('; '));
      return;
    }
    setProblem(null);
    save.mutate(checked.data.items, {
      onSuccess: () => setDrafts(null),
      onError: (err) => setProblem(err.message),
    });
  };

  return (
    <section aria-labelledby={id} className="card">
      <div className="card-head">
        <div className="card-title">
          <h2 id={id}>{title}</h2>
        </div>
        {!drafts && isAdmin && (
          <button
            type="button"
            className="pill"
            onClick={startEditing}
            disabled={tariffs.isPending}
          >
            Edit rates
          </button>
        )}
      </div>

      {tariffs.isPending ? (
        <Skeleton height={80} />
      ) : drafts ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="table-wrap">
            <table className="data tariff-edit">
              <thead>
                <tr>
                  <th scope="col">Fuel</th>
                  <th scope="col">Unit rate (p)</th>
                  <th scope="col">Standing (p/day)</th>
                  <th scope="col">From</th>
                  <th scope="col">To (blank = now)</th>
                  <th scope="col">
                    <span className="sr-only">Remove</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((d, i) => (
                  <tr key={i}>
                    <td>
                      <select
                        aria-label="Fuel"
                        value={d.fuel}
                        onChange={(e) => update(i, { fuel: e.target.value as Draft['fuel'] })}
                      >
                        {fuels.map((f) => (
                          <option key={f} value={f}>
                            {FUEL_NAME[f]}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input
                        aria-label="Unit rate in pence"
                        inputMode="decimal"
                        required
                        value={d.unitRatePence}
                        onChange={(e) => update(i, { unitRatePence: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label="Standing charge in pence per day"
                        inputMode="decimal"
                        value={d.standingPence}
                        onChange={(e) => update(i, { standingPence: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label="Valid from"
                        type="date"
                        required
                        value={d.validFrom}
                        onChange={(e) => update(i, { validFrom: e.target.value })}
                      />
                    </td>
                    <td>
                      <input
                        aria-label="Valid to"
                        type="date"
                        value={d.validTo}
                        onChange={(e) => update(i, { validTo: e.target.value })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="pill"
                        onClick={() => setDrafts(drafts.filter((_, j) => j !== i))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {problem && (
            <p className="banner" role="alert">
              {problem}
            </p>
          )}
          <div className="pills" style={{ flexWrap: 'wrap' }}>
            <button
              type="button"
              className="pill"
              onClick={() =>
                setDrafts([
                  ...drafts,
                  {
                    fuel: firstFuel,
                    unitRatePence: '',
                    standingPence: '',
                    validFrom: '',
                    validTo: '',
                  },
                ])
              }
            >
              Add a rate
            </button>
            <button type="submit" className="pill" aria-pressed="true" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="pill" onClick={() => setDrafts(null)}>
              Cancel
            </button>
          </div>
          <p className="note">
            A new rate needs the old one to end the day before it starts. Costs everywhere are
            recalculated straight away.
          </p>
        </form>
      ) : shown.length ? (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Fuel</th>
                <th scope="col">Unit rate</th>
                <th scope="col">Standing charge</th>
                <th scope="col">Applies</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <tr key={t.id}>
                  <td>{FUEL_NAME[t.fuel]}</td>
                  <td>
                    {t.unitRatePence.toFixed(2)} {UNIT[t.fuel]}
                  </td>
                  <td>{t.standingPence.toFixed(2)} p/day</td>
                  <td>{period(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty>{empty}</Empty>
      )}
      {!drafts && note && <p className="note">{note}</p>}
    </section>
  );
}
