"""Original static append fixtures, independent exact Fraction WLS and mpmath QR.
No product import. Canonical base hash is independently produced for these finite
integer/power-of-two fixtures using JS-compatible normalized JSON numbers.
"""
import json,hashlib,random,platform
from pathlib import Path
from fractions import Fraction as F
import mpmath as mp
assert mp.__version__=='1.3.0'
mp.mp.dps=120

def f(x):return F.from_float(x) if isinstance(x,float) else F(x)
def solve(a,b):
    rows=[list(row)+[rhs]for row,rhs in zip(a,b)];n=len(rows)
    for i in range(n):
        k=next(k for k in range(i,n)if rows[k][i]);rows[i],rows[k]=rows[k],rows[i]
        pivot=rows[i][i];rows[i]=[v/pivot for v in rows[i]]
        for k in range(n):
            if k!=i:
                multiple=rows[k][i];rows[k]=[x-multiple*y for x,y in zip(rows[k],rows[i])]
    return [row[-1]for row in rows]
def serial(value):
    if isinstance(value,list):return [serial(v)for v in value]
    return str(value)
def normalize(value):
    if isinstance(value,dict):return {k:normalize(v)for k,v in value.items()}
    if isinstance(value,list):return [normalize(v)for v in value]
    if isinstance(value,float)and value.is_integer():return int(value)
    return value

def exact_fit(observations):
    a=[[f(v)for v in o['coefficients']]for o in observations];y=[f(o['value'])for o in observations];w=[1/f(o['aprioriVariance'])for o in observations]
    p=len(a[0]);n=len(a)
    normal=[[sum(wi*row[i]*row[j]for wi,row in zip(w,a))for j in range(p)]for i in range(p)]
    rhs=[sum(wi*row[i]*yi for wi,row,yi in zip(w,a,y))for i in range(p)]
    x=solve(normal,rhs);covcols=[solve(normal,[F(i==j)for i in range(p)])for j in range(p)]
    covariance=[list(row)for row in zip(*covcols)]
    fitted=[sum(xj*aj for xj,aj in zip(x,row))for row in a];residuals=[yi-fit for yi,fit in zip(y,fitted)];sse=sum(wi*ri*ri for wi,ri in zip(w,residuals))
    return {k:serial(v)for k,v in dict(parameters=x,aprioriParameterCovariance=covariance,adjustedObservations=fitted,residuals=residuals,weightedResidualSumSquares=sse,posteriorVarianceFactorEstimate=sse/(n-p)).items()}

def high_precision(observations):
    p=len(observations[0]['coefficients']);a=mp.matrix([[mp.mpf(v)/mp.sqrt(mp.mpf(o['aprioriVariance']))for v in o['coefficients']]for o in observations]);y=mp.matrix([mp.mpf(o['value'])/mp.sqrt(mp.mpf(o['aprioriVariance']))for o in observations])
    q,r=mp.qr(a,mode='skinny');x=mp.lu_solve(r,q.T*y);cov=(a.T*a)**-1;residual=y-a*x;sse=(residual.T*residual)[0]
    return dict(parameters=[mp.nstr(v,100)for v in x],aprioriParameterCovariance=[[mp.nstr(cov[i,j],100)for j in range(p)]for i in range(p)],weightedResidualSumSquares=mp.nstr(sse,100))

def obs(name,row,value,variance=1):return dict(id=name,value=float(value),coefficients=list(map(float,row)),aprioriVariance=float(variance),sourceAnchor='original-synthetic:'+name)
def case(name,base_rows,new_rows,p):
    base=dict(schemaVersion=1,model='fixed-datum-full-column-rank-independent-linear-observations',covarianceBasis='caller-declared-known-apriori-independent-absolute-variances',errorModel='caller-declared-zero-mean-independent-errors-no-normality-claim',coefficientMeaning='dimensionless-all-parameters-share-observation-unit',networkId='synthetic:'+name,revision=1,unit='mm',parameterIds=[f'x{j}'for j in range(p)],sourceAnchor='original-synthetic-fixed-model:'+name,sourceSha256='3'*64,observations=base_rows)
    # These hash fixtures contain no exponential decimal notation, so conversion
    # of integral floats to integers gives the same JSON spelling as JS.
    canonical=json.dumps(normalize(base),separators=(',',':'),ensure_ascii=False,allow_nan=False)
    digest=hashlib.sha256(canonical.encode()).hexdigest()
    request=dict(schemaVersion=1,operation='append-independent-observations-only',base=base,expectedBaseFingerprint=digest,append=dict(batchId='append:'+name,nextRevision=2,sourceAnchor='original-synthetic-append:'+name,observations=new_rows))
    prefixes=[]
    for count in range(len(new_rows)+1):
        all_rows=base_rows+new_rows[:count]
        prefixes.append(dict(appended=count,exact=exact_fit(all_rows),mp120=high_precision(all_rows)))
    return dict(name=name,request=request,canonicalBaseUtf8=canonical,prefixes=prefixes)

cases=[]
cases.append(case('equal-weight-location',[obs(f'b{i}',[1],v)for i,v in enumerate([0,2,4])],[obs('a0',[1],8),obs('a1',[1],-1)],1))
cases.append(case('unequal-known-variances',[obs(f'b{i}',[1],v,s)for i,(v,s)in enumerate([(0,1),(2,4),(4,16)])],[obs('a0',[1],8,4),obs('a1',[1],-1,0.25)],1))
cases.append(case('noiseless-fixed-line',[obs(f'b{i}',[1,i],2+3*i)for i in range(4)],[obs('a0',[1,4],14),obs('a1',[1,5],17)],2))
cases.append(case('zero-information-row',[obs(f'b{i}',[1],v)for i,v in enumerate([0,2,4])],[obs('a0',[0],5)],1))
cases.append(case('high-leverage-append',[obs(f'b{i}',[1,i],2+3*i+(i%2)*0.125)for i in range(4)],[obs('a0',[1,1000000],3000002.5)],2))
rng=random.Random(202609202)
for index in range(24):
    p=1+index%4;base=[];new=[]
    truth=[F(rng.randrange(-16,17),4)for _ in range(p)]
    for i in range(p+4):
        row=[F(i==j)for j in range(p)]if i<p else[F(rng.randrange(-8,9),4)for _ in range(p)]
        value=sum(a*x for a,x in zip(row,truth))+F(rng.randrange(-8,9),8)
        base.append(obs(f'b{i}',row,value,[F(1,4),F(1),F(4)][rng.randrange(3)]))
    for i in range(4):
        row=[F(rng.randrange(-8,9),4)for _ in range(p)]
        value=sum(a*x for a,x in zip(row,truth))+F(rng.randrange(-8,9),8)
        new.append(obs(f'a{i}',row,value,[F(1,4),F(1),F(4)][rng.randrange(3)]))
    cases.append(case(f'original-seeded-{index}',base,new,p))

output=dict(provenance=dict(python=platform.python_version(),mpmath=mp.__version__,decimalPrecision=mp.mp.dps,seed=202609202,exactOracle='stdlib Fraction Gauss-Jordan WLS normal equations; no floating normal equations',highPrecisionOracle='mpmath120-digit QR solve plus high precision covariance',inputMeaning='exact values of binary64 observations and variances',synthetic=True),cases=cases)
Path(__file__).with_name('survey-static-incremental-oracle.json').write_text(json.dumps(output,indent=2,allow_nan=False)+'\n')
print(json.dumps({'cases':len(cases),'prefixFits':sum(len(c['prefixes'])for c in cases),'mpmath':mp.__version__}))
