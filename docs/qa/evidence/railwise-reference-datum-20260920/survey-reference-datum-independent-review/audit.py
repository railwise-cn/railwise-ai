from pathlib import Path
from fractions import Fraction as F
import json
import mpmath as mp
mp.mp.dps=120
p=Path(__file__).parent
inputs=json.loads((p/'cases.json').read_text())['cases'];outputs=json.loads((p/'outputs.json').read_text())['cases']
def m(x):
 f=F(x);return mp.mpf(f.numerator)/f.denominator
count=0;maxerr=mp.mpf(0);maxmp=mp.mpf(0);maxcoord=mp.mpf(0);maxcov=mp.mpf(0)
def compare(ex,ac,path,scale=mp.mpf(1)):
 global count,maxerr
 if isinstance(ex,list):
  assert len(ex)==len(ac),(path,len(ex),len(ac))
  for i,(e,a) in enumerate(zip(ex,ac)):compare(e,a,path+f'[{i}]',scale)
 else:
  e=m(ex);a=m(F.from_float(float(ac)));err=abs(a-e)/max(1,abs(e),scale);maxerr=max(maxerr,err);count+=1
  assert err<mp.mpf('2e-12'),(path,str(err))
for case,out in zip(inputs,outputs):
 assert case['name']==out['name'];r=out['result'];assert r['outcome']=='calculated',out
 assert r['sourceRecordsVerified'] is False and r['formalCoordinatesModified'] is False and r['referencePhysicalStability']=='not-evaluated' and r['referenceSelection']=='caller-declared-no-automatic-selection'
 covscale=max(abs(m(x)) for row in case['expected']['differenceCovariance'] for x in row)*(1+sum(abs(m(x)) for x in case['expected']['referenceWeights']))**2
 coordscale=max(abs(m(x)) for x in case['expected']['rawDifferences'])
 for k,v in case['expected'].items():compare(v,r[k],case['name']+'.'+k,covscale if 'Covariance' in k or 'Variance' in k else coordscale if k in ['rawDifferences','referenceShift','displacements'] else 1)
 # Independently high-precision solve and matrix transformation of exact binary64 D.
 D=mp.matrix([[m(x) for x in row] for row in case['expected']['differenceCovariance']]);d=mp.matrix([m(x) for x in case['expected']['rawDifferences']]);q=case['request'];refs=[next(i for i,x in enumerate(q['mapping']) if x['id']==id) for id in q['referenceIds']];n=len(d);w=mp.matrix(n,1)
 if q['method']=='gls-reference-mean':
  raw=mp.lu_solve(mp.matrix([[D[i,j] for j in refs] for i in refs]),mp.matrix([1]*len(refs)));raw=raw/mp.fsum(raw)
 else:raw=mp.matrix([mp.mpf(1)/len(refs)]*len(refs))
 for i,v in zip(refs,raw):w[i]=v
 T=mp.eye(n)-mp.ones(n,1)*w.T;vals={'referenceShift':(w.T*d)[0],'referenceShiftVariance':(w.T*D*w)[0],'displacementCovariance':T*D*T.T}
 for k,val in vals.items():
  ex=case['expected'][k]
  if isinstance(ex,list):pairs=[(m(ex[i][j]),val[i,j]) for i in range(n) for j in range(n)]
  else:pairs=[(m(ex),val)]
  for a,b in pairs:maxmp=max(maxmp,abs(a-b)/max(1,abs(a)))
 coord=max(abs(m(F.from_float(float(r['referenceShift'])))-m(case['expected']['referenceShift'])),*[abs(m(F.from_float(float(x)))-m(e)) for x,e in zip(r['displacements'],case['expected']['displacements'])]);cov=max(abs(m(F.from_float(float(r['referenceShiftVariance'])))-m(case['expected']['referenceShiftVariance'])),*[abs(m(F.from_float(float(x)))-m(e)) for xr,er in zip(r['displacementCovariance'],case['expected']['displacementCovariance']) for x,e in zip(xr,er)])
 ce=m(F.from_float(r['numerical']['coordinateRoundoffEstimate']));ve=m(F.from_float(r['numerical']['covarianceRoundoffEstimate']));assert coord<=ce and cov<=ve,(case['name'],'outside software diagnostic',str(coord),str(ce),str(cov),str(ve));maxcoord=max(maxcoord,coord/ce if ce else 0);maxcov=max(maxcov,cov/ve if ve else 0)
assert maxmp<mp.mpf('1e-110')
summary={'cases':len(inputs),'scalarComparisons':count,'maxScaledProductError':str(maxerr),'maxFractionVs120DigitError':str(maxmp),'maxCoordinateErrorOverSoftwareEstimate':str(maxcoord),'maxCovarianceErrorOverSoftwareEstimate':str(maxcov),'mpmath':mp.__version__}
(p/'audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
