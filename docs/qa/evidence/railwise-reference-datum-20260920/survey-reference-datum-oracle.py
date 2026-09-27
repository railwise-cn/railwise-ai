"""Original rational reference-datum fixtures; no product imports.
Python 3.12.7 standard-library Fraction solves exact declared rational models.
mpmath==1.3.0 independently solves exact binary64-input GLS at 120 digits.
"""
from fractions import Fraction as F
from pathlib import Path
import json, random, platform
import mpmath as mp
assert mp.__version__ == '1.3.0'
mp.mp.dps=120

def eye(n):return [[F(i==j) for j in range(n)] for i in range(n)]
def transpose(a):return list(map(list,zip(*a)))
def matmul(a,b):return [[sum(x*y for x,y in zip(row,col)) for col in zip(*b)] for row in a]
def solve(a,b):
    a=[list(row)+[rhs] for row,rhs in zip(a,b)]
    for i in range(len(a)):
        k=next(k for k in range(i,len(a)) if a[k][i])
        a[i],a[k]=a[k],a[i]
        pivot=a[i][i];a[i]=[v/pivot for v in a[i]]
        for k in range(len(a)):
            if k!=i:
                factor=a[k][i];a[k]=[x-factor*y for x,y in zip(a[k],a[i])]
    return [row[-1] for row in a]
def strings(value):
    if isinstance(value,list):return [strings(v)for v in value]
    return str(value)
def floats(value):
    if isinstance(value,list):return [floats(v)for v in value]
    return float(value)
def expected(first,second,c1,c2,c12,refs,method):
    n=len(first);d=[b-a for a,b in zip(first,second)]
    covariance=[[c1[i][j]+c2[i][j]-c12[i][j]-c12[j][i] for j in range(n)]for i in range(n)]
    if method=='gls-reference-mean':
        solved=solve([[covariance[i][j]for j in refs]for i in refs],[F(1)]*len(refs));weights=[v/sum(solved)for v in solved]
    else:weights=[F(1,len(refs))]*len(refs)
    w=[weights[refs.index(i)]if i in refs else F(0)for i in range(n)]
    t=[[F(i==j)-w[j]for j in range(n)]for i in range(n)]
    shift=sum(x*y for x,y in zip(w,d));cw=[sum(row[j]*w[j]for j in range(n))for row in covariance]
    return dict(rawDifferences=d,differenceCovariance=covariance,referenceWeights=w,referenceShift=shift,referenceShiftVariance=sum(x*y for x,y in zip(w,cw)),displacements=[x-shift for x in d],displacementCovariance=matmul(matmul(t,covariance),transpose(t)),shiftDisplacementCovariance=[sum(x*y for x,y in zip(row,cw))for row in t],transformation=t)

def binary_mp_oracle(request):
    n=len(request['mapping']);first=request['firstEpoch'];second=request['secondEpoch']
    c1=mp.matrix([[mp.mpf(v)for v in row]for row in first['covariance']]);c2=mp.matrix([[mp.mpf(v)for v in row]for row in second['covariance']])
    c12=mp.zeros(n) if request['dependence']['kind']=='caller-declared-independent' else mp.matrix([[mp.mpf(v)for v in row]for row in request['dependence']['firstToSecondCovariance']])
    c=c1+c2-c12-c12.T;d=mp.matrix([mp.mpf(b['coordinate'])-mp.mpf(a['coordinate'])for a,b in zip(first['points'],second['points'])])
    refs=[int(s[1:])for s in request['referenceIds']]
    if request['method']=='gls-reference-mean':
        cr=mp.matrix([[c[i,j]for j in refs]for i in refs]);v=mp.lu_solve(cr,mp.matrix([1]*len(refs)));local=v/sum(v)
    else:local=mp.matrix([mp.mpf(1)/len(refs)]*len(refs))
    w=mp.matrix([local[refs.index(i)]if i in refs else 0 for i in range(n)]);t=mp.eye(n)-mp.matrix([1]*n)*w.T;shift=(w.T*d)[0]
    v=t*c*t.T
    return {'referenceWeights':[mp.nstr(x,100)for x in w], 'referenceShift':mp.nstr(shift,100),'referenceShiftVariance':mp.nstr((w.T*c*w)[0],100),'displacements':[mp.nstr(x,100)for x in t*d], 'displacementCovariance':[[mp.nstr(v[i,j],100)for j in range(n)]for i in range(n)]}

def case(name,first,second,c1,c2,c12,refs,method,dependent=False):
    n=len(first)
    e=lambda label,values,cov:dict(id=label,sourceAnchor='original-synthetic:'+name+':'+label,sourceSha256=('1'if label=='epoch-1'else'2')*64,covarianceBasis='caller-declared-full-coordinate-covariance-not-cofactor',points=[dict(id=f'p{i}',coordinate=float(v))for i,v in enumerate(values)],covariance=floats(cov))
    request=dict(schemaVersion=1,model='two-epoch-one-dimensional-declared-reference-datum',unit='mm',method=method,referenceDeclaration='caller-selected-reference-set-not-verified-stable',testingStrategy='none-datum-comparison-only',firstEpoch=e('epoch-1',first,c1),secondEpoch=e('epoch-2',second,c2),mapping=[dict(id=f'p{i}',firstPointId=f'p{i}',secondPointId=f'p{i}')for i in range(n)],referenceIds=[f'p{i}'for i in refs],dependence=dict(kind='caller-declared-cross-covariance',sourceAnchor='synthetic-known-joint-factor',firstToSecondCovariance=floats(c12))if dependent else dict(kind='caller-declared-independent',sourceAnchor='synthetic-independent-errors'))
    rational=expected(list(map(F,first)),list(map(F,second)),c1,c2,c12,refs,method)
    return dict(name=name,request=request,exactRational=strings_dict(rational),binary120=binary_mp_oracle(request))
def strings_dict(value):return {k:strings(v)for k,v in value.items()}

cases=[]
n=3;c1=eye(n);c2=eye(n);zero=[[F(0)]*n for _ in range(n)]
for method in ['gls-reference-mean','equal-reference-mean']:
    cases.append(case('three-equal-variance-'+method,[0,0,0],[0,0,3],c1,c2,zero,[0,1,2],method))
# Unequal variances, and correlated references that produce a legitimate negative GLS weight.
c1=[[F(1,2),F(1),F(0)],[F(1),F(5,2),F(0)],[F(0),F(0),F(1)]]
c2=[row[:]for row in c1]
for method in ['gls-reference-mean','equal-reference-mean']:
    cases.append(case('negative-gls-weight-'+method,[10,20,30],[11,23,36],c1,c2,zero,[0,1],method))
# Two free-datum covariance matrices (I-J/4), exact binary representations.
n=4;c=[[F(i==j)-F(1,n)for j in range(n)]for i in range(n)];z=[[F(0)]*n for _ in range(n)]
cases.append(case('free-datum-proper-subset-gls',[100]*n,[101,102,103,106],c,c,z,[0,1],'gls-reference-mean'))
cases.append(case('free-datum-all-equal',[100]*n,[101,102,103,106],c,c,z,list(range(n)),'equal-reference-mean'))
# Original full correlated joint covariance from exact lower-triangular factors.
rng=random.Random(20260920)
for index in range(24):
    n=2+index%5;m=2*n
    lower=[[F(rng.randrange(-3,4),4)if j<i else F(2+index%3)if i==j else F(0)for j in range(m)]for i in range(m)]
    joint=matmul(lower,transpose(lower));c1=[row[:n]for row in joint[:n]];c2=[row[n:]for row in joint[n:]];cross=[row[n:]for row in joint[:n]]
    first=[F(rng.randrange(-100,101),8)for _ in range(n)];second=[v+F(rng.randrange(-24,25),8)for v in first]
    for method in ['gls-reference-mean','equal-reference-mean']:
        cases.append(case(f'joint-factor-{index}-{method}',first,second,c1,c2,cross,list(range(max(2,n-1))),method,True))

result=dict(provenance=dict(python=platform.python_version(),mpmath=mp.__version__,decimalPrecision=mp.mp.dps,rationalOracle='stdlib Fraction Gauss-Jordan independent exact arithmetic',highPrecisionOracle='mpmath lu_solve and matrix products at exact binary64 input values',synthetic=True,randomSeed=20260920),cases=cases)
Path(__file__).with_name('survey-reference-datum-oracle.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
print(json.dumps({'cases':len(cases),'python':platform.python_version(),'mpmath':mp.__version__}))
