#!/usr/bin/env python3
"""
Builds server/data/zip3.json — the national ZIP3 grid Barometer scores on.

Inputs (both public Census files):
  2023_Gaz_zcta_national.txt          ZCTA centroids and land area
  tab20_zcta520_county20_natl.txt     ZCTA -> county relationship (gives state FIPS)

Each ZIP3 cell carries a land-area-weighted centroid, its dominant state,
the number of ZCTAs it aggregates and its total land area. The grid is what
every feed is resolved onto, so it is generated once and committed.

usage: python3 scripts/build-zip3.py <gazetteer.txt> <zcta_county.txt>
"""
import csv, json, sys
from collections import defaultdict

FIPS_TO_STATE = {
 '01':'AL','02':'AK','04':'AZ','05':'AR','06':'CA','08':'CO','09':'CT','10':'DE','11':'DC','12':'FL','13':'GA',
 '15':'HI','16':'ID','17':'IL','18':'IN','19':'IA','20':'KS','21':'KY','22':'LA','23':'ME','24':'MD','25':'MA',
 '26':'MI','27':'MN','28':'MS','29':'MO','30':'MT','31':'NE','32':'NV','33':'NH','34':'NJ','35':'NM','36':'NY',
 '37':'NC','38':'ND','39':'OH','40':'OK','41':'OR','42':'PA','44':'RI','45':'SC','46':'SD','47':'TN','48':'TX',
 '49':'UT','50':'VT','51':'VA','53':'WA','54':'WV','55':'WI','56':'WY','72':'PR'
}

gaz_path, rel_path = sys.argv[1], sys.argv[2]

# ZCTA -> state, picking the county part with the most land
zcta_state_land = defaultdict(lambda: defaultdict(int))
with open(rel_path, encoding='utf-8-sig') as f:
    for row in csv.DictReader(f, delimiter='|'):
        z = row['GEOID_ZCTA5_20']; c = row['GEOID_COUNTY_20']
        if not z or not c: continue
        st = FIPS_TO_STATE.get(c[:2])
        if not st: continue
        zcta_state_land[z][st] += int(row['AREALAND_PART'] or 0)
zcta_state = {z: max(d.items(), key=lambda kv: kv[1])[0] for z, d in zcta_state_land.items()}

cells = defaultdict(lambda: {'lat':0.0,'lon':0.0,'w':0,'n':0,'states':defaultdict(int)})
with open(gaz_path, encoding='utf-8') as f:
    for row in csv.DictReader(f, delimiter='\t'):
        row = {k.strip(): (v.strip() if v else v) for k, v in row.items()}
        z = row['GEOID']; z3 = z[:3]
        st = zcta_state.get(z)
        if not st or st == 'PR': continue
        land = int(row['ALAND'] or 0) or 1
        lat, lon = float(row['INTPTLAT']), float(row['INTPTLONG'])
        c = cells[z3]
        c['lat'] += lat*land; c['lon'] += lon*land; c['w'] += land; c['n'] += 1
        c['states'][st] += land

out = []
for z3, c in sorted(cells.items()):
    st = max(c['states'].items(), key=lambda kv: kv[1])[0]
    out.append({
        'zip3': z3, 'state': st,
        'lat': round(c['lat']/c['w'], 4), 'lon': round(c['lon']/c['w'], 4),
        'zctas': c['n'], 'landKm2': round(c['w']/1e6, 1)
    })
json.dump(out, open('server/data/zip3.json','w'), separators=(',',':'))
print(f'wrote {len(out)} ZIP3 cells across {len(set(o["state"] for o in out))} states')
