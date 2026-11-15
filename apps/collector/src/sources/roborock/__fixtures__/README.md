`snapshot.json` is the helper's `GET /snapshot` answer (docker/roborock/helper.py) in the shape
of a real Roborock S8 capture from 2026-11-15: `get_status`, `get_clean_summary`,
`get_multi_maps_list` and one `get_clean_record` per run. Times, durations, areas and counts
are invented. Runs with `map_flag` -1 or none are cleans without a map (landings, single
rooms; the real S8 sent 6 of 20 runs in a shape the first parser refused, most likely -1); the
1-second run is a false start; `map_flag` 2 is a map that has since been deleted.
