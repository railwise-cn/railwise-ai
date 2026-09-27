"""Independent high-precision checks of recorded TypeScript outputs."""
import json
from pathlib import Path
from fractions import Fraction
import mpmath as mp
mp.mp.dps=180
base=Path(__file__).parent

def declared(v):return mp.mpf(float(Fraction(str(v))))

stat=json.loads((base/'survey-statistical-family-review-probe-results.json').read_text())
max_log=mp.mpf(0);below=0
for c in stat['results']:
    r=c['result'];truth=mp.mpf(c['p120'])
    if r['status']!='calculated':
        assert truth<mp.mpf('1e-300')and r['code']=='probability-below-supported-range',(c,r)
        below+=1;continue
    error=abs(mp.mpf(r['logPValue'])-mp.mpf(c['logP120']));max_log=max(max_log,error)
    assert error<mp.mpf('5e-11'),(c,error)
for c in stat['criticals']:
    q=mp.mpf(c['quantile120'])
    for point in c['points']:
        r=point['result'];assert r['status']=='calculated'
        lo,hi=map(mp.mpf,r['numericalResolutionInterval']);assert lo<q<hi
        expect='boundary-unresolved'if point['point']in['predecessor','nearest','successor']else'p-above-adjusted-alpha'if point['point']=='farBelow'else'p-below-adjusted-alpha'
        assert r['comparison']==expect,(c,point)
assert all(item['result']['outcome']=='invalid-input' for item in stat['extraResults'][:3])
assert all(item['result']['outcome']=='evaluated' and item['result']['results'][0]['status']=='domain-failure' for item in stat['extraResults'][3:])
assert stat['mixedResult']['denominator']==4
assert [r['status']for r in stat['mixedResult']['results']]==['calculated','unavailable','undetectable','domain-failure']
assert stat['mixedResult']['results'][0]['adjustedPValue']==4*stat['mixedResult']['results'][0]['pValue']

summary={'tailCases':len(stat['results']),'calculated':len(stat['results'])-below,'correctBelowSupportedRange':below,'maxAbsoluteLogProbabilityError':float(max_log),'criticalCases':len(stat['criticals']),'nearAndFarThresholdEvaluations':sum(len(c['points'])for c in stat['criticals']),'allTrueQuantilesWithinSoftwareIntervals':True}
(base/'survey-statistical-family-review-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary,indent=2))
