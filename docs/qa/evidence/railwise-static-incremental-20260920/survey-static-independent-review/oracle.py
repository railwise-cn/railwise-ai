from fractions import Fraction as F
import json,random,copy
from pathlib import Path
p=Path(__file__).parent;rng=random.Random(99170923)
def inv(a):
 n=len(a);b=[list(a[i])+[F(i==j) for j in range(n)] for i in range(n)]
 for i in range(n):
  k=next(j for j in range(i,n) if b[j][i]);b[k],b[i]=b[i],b[k];v=b[i][i];b[i]=[x/v for x in b[i]]
  for j in range(n):
   if j!=i:v=b[j][i];b[j]=[x-v*y for x,y in zip(b[j],b[i])]
 return [r[n:] for r in b]
def fit(observations):
 f=lambda x:F.from_float(float(x));A=[list(map(f,o['coefficients'])) for o in observations];y=[f(o['value']) for o in observations];w=[1/f(o['aprioriVariance']) for o in observations];n=len(y);m=len(A[0]);N=[[sum(w[k]*A[k][i]*A[k][j] for k in range(n)) for j in range(m)] for i in range(m)];C=inv(N);b=[sum(w[k]*A[k][i]*y[k] for k in range(n)) for i in range(m)];x=[sum(C[i][j]*b[j] for j in range(m)) for i in range(m)];adj=[sum(a*v for a,v in zip(row,x)) for row in A];v=[a-b for a,b in zip(y,adj)];sse=sum(wi*vi*vi for wi,vi in zip(w,v));return dict(parameters=x,aprioriParameterCovariance=C,adjustedObservations=adj,residuals=v,weightedResidualSumSquares=sse,degreesOfFreedom=n-m,posteriorVarianceFactorEstimate=sse/(n-m),weightedObservationEnergy=sum(wi*yi*yi for wi,yi in zip(w,y)))
def row(i,a,y,var=1):return {'id':'obs-'+str(i),'value':float(y),'coefficients':list(map(float,a)),'aprioriVariance':float(var),'sourceAnchor':'independent-synthetic-row'}
def base(rows,pars,unit='m'):return {'schemaVersion':1,'model':'fixed-datum-full-column-rank-independent-linear-observations','covarianceBasis':'caller-declared-known-apriori-independent-absolute-variances','errorModel':'caller-declared-zero-mean-independent-errors-no-normality-claim','coefficientMeaning':'dimensionless-all-parameters-share-observation-unit','networkId':'independent-network','revision':11,'unit':unit,'parameterIds':['parameter-'+str(i) for i in range(pars)],'sourceAnchor':'independent-base','sourceSha256':'5'*64,'observations':rows}
def encode(v):
 if isinstance(v,F):return str(v.numerator)+'/'+str(v.denominator)
 if isinstance(v,list):return list(map(encode,v))
 if isinstance(v,dict):return {k:encode(x) for k,x in v.items()}
 return v
cases=[]
def add(name,b,extra):cases.append({'name':name,'base':b,'append':{'batchId':'independent-append','nextRevision':12,'sourceAnchor':'independent-append-source','observations':extra},'prefixes':[encode(fit(b['observations']+extra[:i])) for i in range(len(extra)+1)]})
for case in range(24):
 m=1+case%5;rows=[row(i,[F(i==j) for j in range(m)],rng.randrange(-30,31),[F(1,4),F(1),F(4)][i%3]) for i in range(m)]
 for i in range(m,m+3):rows.append(row(i,[F(rng.randrange(-8,9),4) for _ in range(m)],F(rng.randrange(-100,101),8),[F(1,4),F(1),F(4)][i%3]))
 extra=[row(len(rows)+i,[F(rng.randrange(-8,9),4) for _ in range(m)],F(rng.randrange(-100,101),8),[F(1,4),F(1),F(4)][i%3]) for i in range(1+case%6)]
 b=base(rows,m);add('random-'+str(case),b,extra)
 if case<6:
  add('reverse-append-'+str(case),copy.deepcopy(b),list(reversed(copy.deepcopy(extra))))
  perm=copy.deepcopy(b);perm['observations'].reverse();add('reverse-base-'+str(case),perm,copy.deepcopy(extra))
  unit=copy.deepcopy(b);unit['unit']='mm';new=copy.deepcopy(extra)
  for o in unit['observations']+new:o['value']*=1000;o['aprioriVariance']*=1000000
  add('unit-'+str(case),unit,new)
  scaled=copy.deepcopy(b);new=copy.deepcopy(extra)
  for o in scaled['observations']+new:o['aprioriVariance']*=16
  add('variance-scale-'+str(case),scaled,new)
add('large-residual-known-prior',base([row(0,[1],0),row(1,[1],2)],1),[row(2,[1],10)])
add('zero-information-append',base([row(0,[1],0),row(1,[1],2)],1),[row(2,[0],3),row(3,[1],-2)])
add('exact-zero-sse',base([row(0,[1],2),row(1,[1],2)],1),[row(2,[1],2),row(3,[2],4)])
add('high-leverage-p1',base([row(0,[F(1,1000000)],1),row(1,[F(1,1000000)],2)],1),[row(2,[1000000],5),row(3,[2],3)])
add('high-leverage-p2',base([row(0,[1,0],1),row(1,[0,1],2),row(2,[1,1],2)],2),[row(3,[1000000,0],5),row(4,[0,2],3)])
(p/'cases.json').write_text(json.dumps({'seed':99170923,'basis':'Fraction of actual supplied binary64','cases':cases},indent=2)+'\n');print(json.dumps({'models':len(cases),'prefixFits':sum(len(c['prefixes']) for c in cases)}))
