import json, itertools, random
from fractions import Fraction as F
from pathlib import Path
cases=[]
def add(tag,a,y,q,theta=1):
 n=len(y);af=list(map(F,a));yf=list(map(F,y));qf=list(map(F,q));den=sum(ai*ai/qi for ai,qi in zip(af,qf));x=sum(ai*yi/qi for ai,yi,qi in zip(af,yf,qf))/den
 residual=[yi-ai*x for yi,ai in zip(yf,af)];v=sum(e*e/qi for e,qi in zip(residual,qf))/(n-1)
 cases.append(dict(tag=tag,input=dict(schemaVersion=1,model='fixed-linear-independent-disjoint-variance-groups',unit='m',parameterIds=['x'],groups=[dict(id='g',initialVariance=theta,sourceAnchor='independent-boundary-review')],observations=[dict(id=str(i),value=yi,coefficients=[ai],groupId='g',relativeVariance=qi,sourceAnchor='independent-Fraction') for i,(ai,yi,qi) in enumerate(zip(a,y,q))],maxIterations=100,relativeTolerance=1e-12),expectedVariance=float(v),expectedX=float(x),expectedResidual=list(map(float,residual))))
for n,scale,shift,qscale,ascl in itertools.product([2,3,5],[1e-200,1e-160,1e-12,1e-9,1e-6,1,1e4],[0,1,1e4,9e5],[1e-8,1,1e8],[1e-300,1,1e300]):
 a=[ascl]*n;y=[shift+scale*(i-(n-1)/2) for i in range(n)];q=[qscale]*n
 if max(map(abs,y))<=1e6:add(f'grid-{len(cases)}',a,y,q)
rng=random.Random(20260921)
for i in range(600):
 n=rng.choice([3,5,9]);a=[rng.choice([.25,.5,1,2,4]) for _ in range(n)];q=[10.**rng.randint(-4,4) for _ in range(n)];shift=rng.choice([0,1,1e4,1e5]);scale=10.**rng.randint(-10,3);y=[aa*shift+scale*rng.randint(-5,5) for aa in a]
 add(f'random-{i}',a,y,q,10.**rng.randint(-18,18))
Path(__file__).with_name('cases.json').write_text(json.dumps(cases))
print(len(cases))
