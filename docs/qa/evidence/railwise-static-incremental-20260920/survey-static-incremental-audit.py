"""Audit actual compiled Node outputs against independent exact/120-digit results."""
import json, math
from fractions import Fraction as F
from pathlib import Path
root=Path(__file__).parent
oracle=json.loads((root/'survey-static-incremental-oracle.json').read_text())
outputs=json.loads((root/'survey-static-incremental-node-output.json').read_text())
by_name={c['name']:c for c in oracle['cases']}
comparisons=0;max_scaled=0;max_covariance_scaled=0;max_residual_allowance_fraction=0
seen=set()
def number(x):return float(F(x))
def scalar(a,e,tolerance=2e-10):
    global comparisons,max_scaled
    target=number(e);error=abs(a-target)/max(1,abs(target));comparisons+=1;max_scaled=max(max_scaled,error)
    assert error<=tolerance,(a,e,error)
for item in outputs['outputs']:
    key=(item['name'],item['appended']);assert key not in seen;seen.add(key)
    c=by_name[item['name']];prefix=next(p for p in c['prefixes']if p['appended']==item['appended'])
    result=item['result'];assert result['outcome']=='calculated';assert result['computedBaseFingerprint']==c['request']['expectedBaseFingerprint']
    fit=result['updatedFit']if item['appended']else result['baseFit']
    observations=c['request']['base']['observations']+c['request']['append']['observations'][:item['appended']]
    for expected in [prefix['exact'],prefix['mp120']]:
        for field,values in expected.items():
            if field=='aprioriParameterCovariance':
                for i,row in enumerate(values):
                    for j,value in enumerate(row):
                        scale=math.sqrt(number(values[i][i]))*math.sqrt(number(values[j][j]));error=abs(fit[field][i][j]-number(value))/scale
                        comparisons+=1;max_covariance_scaled=max(max_covariance_scaled,error);assert error<2e-10,(key,field,i,j,error)
            elif field=='residuals':
                for i,value in enumerate(values):
                    target=number(value);o=observations[i];scale=abs(o['value'])+sum(abs(a*x)for a,x in zip(o['coefficients'],fit['parameters']))
                    allowance=2e-10*max(1,abs(target))+2*2**-52*scale;fraction=abs(fit[field][i]-target)/allowance
                    comparisons+=1;max_residual_allowance_fraction=max(max_residual_allowance_fraction,fraction);assert fraction<=1,(key,field,i,fraction)
            elif isinstance(values,list):
                for a,e in zip(fit[field],values):scalar(a,e)
            else:scalar(fit[field],values)
assert len(seen)==sum(len(c['prefixes'])for c in oracle['cases'])==133
report=dict(status='pass',cases=len(by_name),prefixFits=len(seen),scalarComparisons=comparisons,maximumScaledNonCovarianceError=max_scaled,maximumDiagonalScaledCovarianceError=max_covariance_scaled,maximumResidualAllowanceFraction=max_residual_allowance_fraction,residualPolicy='2e-10 max(1,abs(expected)) + 2 epsilon (abs(y) + sum(abs(A*x))); handles sub-ULP residual cancellation',oracle='independent exact Fraction and mpmath 1.3.0 / 120 decimal digits',certifiedErrorBound=False)
(root/'survey-static-incremental-audit-summary.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
