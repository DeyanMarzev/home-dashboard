Met Office warnings RSS (`https://www.metoffice.gov.uk/public/data/PWSCache/WarningsRSS/Region/<code>`,
docs/10 §4), fetched 21 Nov 2026:

- `se-none.xml`: the real London & South East England feed with no warnings.
- `uk-one-yellow.xml`: the real UK-wide feed with one yellow rain warning for South West England
  (Cornwall, Devon, …): a warning that must not alert for Waltham Forest.
- `se-mixed.xml`: **constructed** in exactly the real item format (title, link with `id=`,
  description "…: <areas> valid from HHMM Ddd DD Mon to HHMM Ddd DD Mon", guid with `&region=`),
  because no London warning was out when the real feeds were captured. Ids and times are invented:
  yellow wind naming Waltham Forest, amber rain for Greater London, yellow snow/ice for Kent only,
  and a yellow fog warning for Waltham Forest that has expired by "now" in the tests
  (Mon 23 Nov 2026, 10:00). Replace with a real capture when a London warning is out.
