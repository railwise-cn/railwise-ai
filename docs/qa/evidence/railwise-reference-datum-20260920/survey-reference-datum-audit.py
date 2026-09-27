"""Audit actual compiled-Node results against the independent exact/high precision fixtures."""
import json
from pathlib import Path
from fractions import Fraction
import mpmath as mp
assert mp.__version__=='1.3.0'
mp.mp.dps=120
base=Path(__file__).parent
fixture=json.loads((base/'survey-reference-datum-oracle.json').read_text())
actual=json.loads((base/'survey-reference-datum-node-output.json').read_text())
by_name={item['name']:item['result']for item in actual['outputs']}
maximum=mp.mpf(0);comparisons=0

def exact(value):
    f=Fraction(value)
    return mp.mpf(f.numerator)/f.denominator

def check(a,b):
    global maximum,comparisons
    if isinstance(b,list):
        assert len(a)==len(b)
        for av,bv in zip(a,b):check(av,bv)
    else:
        truth=exact(b);error=abs(mp.mpf(a)-truth)/max(1,abs(truth))
        maximum=max(maximum,error);comparisons+=1
        assert error<mp.mpf('2e-11'),(a,b,error)

for case in fixture['cases']:
    result=by_name[case['name']]
    assert result['outcome']=='calculated'
    assert result['request']==case['request']
    assert result['covarianceCheck']['matrixRepair']=='none'
    assert result['referencePhysicalStability']=='not-evaluated'
    for field,value in case['exactRational'].items():check(result[field],value)
    for field,value in case['binary120'].items():check(result[field],value)

summary=dict(pythonOracle='Fraction and mpmath1.3.0 at 120 digits',node=actual['node'],cases=len(fixture['cases']),scalarComparisons=comparisons,maxScaledAbsoluteDifference=mp.nstr(maximum,40),allPassed=True,scope='declared synthetic models, no runtime or human engineering acceptance')
(base/'survey-reference-datum-audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
print(json.dumps(summary,indent=2))
