from pathlib import Path
from fractions import Fraction as F
import json
import mpmath as mp
mp.mp.dps=120
root=Path(__file__).parent;cases=json.loads((root/'cases.json').read_text())['cases'];outputs=json.loads((root/'outputs.json').read_text())['cases']
def m(x):
 f=F.from_float(x) if isinstance(x,float) else F(x);return mp.mpf(f.numerator)/f.denominator
maxerr=mp.mpf(0);maxmp=mp.mpf(0);count=0;fits=0
for c,out in zip(cases,outputs):
 assert c['name']==out['name']
 for k,r in enumerate(out['prefixes'],1):
  assert r['outcome']=='calculated'
  assert r['sourceRecordsVerified'] is False and r['priorRuntimeStateVerified'] is False and r['originalObservationsModified'] is False and r['formalResultsModified'] is False
  assert r['persistenceAndCrossRequestIdempotency']=='not-implemented-pure-replay-only'
  for key,idx,obs in [('baseFit',0,c['base']['observations']),('updatedFit',k,c['base']['observations']+c['append']['observations'][:k]),('referenceFit',k,c['base']['observations']+c['append']['observations'][:k])]:
   got=r['batchCheck'][key] if key=='referenceFit' else r[key];ex=c['prefixes'][idx];n=len(obs);p=len(ex['parameters']);energy=m(ex['weightedObservationEnergy']);C=mp.matrix([[m(x) for x in row] for row in ex['aprioriParameterCovariance']]);x=mp.matrix([m(a) for a in ex['parameters']]);sse=m(ex['weightedResidualSumSquares']);assert got['degreesOfFreedom']==n-p;assert got['posteriorEstimateUse']=='diagnostic-only-not-applied-to-prior-covariance-or-weights'
   def check(a,b,scale):
    global count,maxerr
    err=abs(m(a)-m(b))/max(mp.mpf('1e-100'),scale);count+=1;maxerr=max(maxerr,err);assert err<mp.mpf('1e-8'),(c['name'],key,idx,str(err),a,b)
   for i in range(p):
    check(got['parameters'][i],ex['parameters'][i],max(1,abs(x[i]),mp.sqrt(C[i,i]*energy)))
    for j in range(p):check(got['aprioriParameterCovariance'][i][j],ex['aprioriParameterCovariance'][i][j],mp.sqrt(C[i,i]*C[j,j]))
   coordscale=max(1,*[abs(m(o['value'])) for o in obs])
   for field in ['adjustedObservations','residuals']:
    for a,b in zip(got[field],ex[field]):check(a,b,coordscale)
   check(got['weightedResidualSumSquares'],ex['weightedResidualSumSquares'],max(sse,mp.mpf(2)**-52*n*energy))
   check(got['posteriorVarianceFactorEstimate'],ex['posteriorVarianceFactorEstimate'],max(sse,mp.mpf(2)**-52*n*energy)/(n-p));fits+=1
   # High precision independent normal-equation solve and propagation on actual binary64.
   A=mp.matrix([[m(a) for a in o['coefficients']] for o in obs]);P=mp.diag([1/m(o['aprioriVariance']) for o in obs]);Y=mp.matrix([m(o['value']) for o in obs]);N=A.T*P*A;xx=mp.lu_solve(N,A.T*P*Y);CC=N**-1;V=Y-A*xx;SS=(V.T*P*V)[0]
   for a,b in [(x[i],xx[i]) for i in range(p)]+[(C[i,j],CC[i,j]) for i in range(p) for j in range(p)]+[(sse,SS)]:maxmp=max(maxmp,abs(a-b)/max(1,abs(a)))
 # Every multi-row step state must match independent separate-prefix run.
 final=out['prefixes'][-1]
 for i,r in enumerate(out['prefixes']):assert final['steps'][i]['stateSha256']==r['updatedQrState']['stateSha256']
# Golden known prior covariance stays 1/3 even when SSE/df is 28.
g=next(c for c in outputs if c['name']=='large-residual-known-prior')['prefixes'][0]['updatedFit'];assert abs(g['aprioriParameterCovariance'][0][0]-1/3)<1e-14;assert abs(g['posteriorVarianceFactorEstimate']-28)<1e-12
assert maxmp<mp.mpf('1e-100')
summary={'models':len(cases),'appendPrefixes':sum(len(c['prefixes']) for c in outputs),'fitComparisons':fits,'scalarComparisons':count,'maximumOperationScaledError':str(maxerr),'maximumFractionVs120DigitError':str(maxmp),'knownPriorNotPosteriorScaled':True,'allPrefixStateHashesReproduced':True};(root/'audit-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary))
