#!/usr/bin/env python3
from fractions import Fraction as F
import random,json,copy
from pathlib import Path
import mpmath as mp
mp.mp.dps=120
out=Path(__file__).parent
rng=random.Random(280620261)

def matmul(a,b):return [[sum(a[i][k]*b[k][j] for k in range(len(b))) for j in range(len(b[0]))] for i in range(len(a))]
def transpose(a):return list(map(list,zip(*a)))
def inverse(a):
 n=len(a);b=[list(a[i])+[F(i==j) for j in range(n)] for i in range(n)]
 for i in range(n):
  k=next(k for k in range(i,n) if b[k][i]);b[i],b[k]=b[k],b[i];p=b[i][i];b[i]=[x/p for x in b[i]]
  for k in range(n):
   if k!=i:p=b[k][i];b[k]=[x-p*y for x,y in zip(b[k],b[i])]
 return [r[n:] for r in b]
def make(n,J,d,refs=None,method='gls-reference-mean',origin=0):
 return {'schemaVersion':1,'model':'two-epoch-one-dimensional-declared-reference-datum','unit':'m','method':method,'referenceDeclaration':'caller-selected-reference-set-not-verified-stable','testingStrategy':'none-datum-comparison-only','firstEpoch':{'id':'first','sourceAnchor':'independent-synthetic-first','sourceSha256':'1'*64,'covarianceBasis':'caller-declared-full-coordinate-covariance-not-cofactor','points':[{'id':f'a{i}','coordinate':float(origin+F(i,8))} for i in range(n)],'covariance':[[float(x) for x in r[:n]] for r in J[:n]]},'secondEpoch':{'id':'second','sourceAnchor':'independent-synthetic-second','sourceSha256':'2'*64,'covarianceBasis':'caller-declared-full-coordinate-covariance-not-cofactor','points':[{'id':f'b{i}','coordinate':float(origin+F(i,8)+d[i])} for i in range(n)],'covariance':[[float(x) for x in r[n:]] for r in J[n:]]},'mapping':[{'id':f'p{i}','firstPointId':f'a{i}','secondPointId':f'b{i}'} for i in range(n)],'referenceIds':[f'p{i}' for i in (refs if refs is not None else range(n))],'dependence':{'kind':'caller-declared-cross-covariance','sourceAnchor':'independent-joint-factor','firstToSecondCovariance':[[float(x) for x in r[n:]] for r in J[:n]]}}
def oracle(q):
 n=len(q['mapping']);e1=q['firstEpoch'];e2=q['secondEpoch'];i1=[next(i for i,p in enumerate(e1['points']) if p['id']==m['firstPointId']) for m in q['mapping']];i2=[next(i for i,p in enumerate(e2['points']) if p['id']==m['secondPointId']) for m in q['mapping']]
 # Exact fractions of actual supplied binary64, including native-axis permutations.
 cv=lambda x:F.from_float(float(x))
 c1=[[cv(e1['covariance'][i][j]) for j in i1] for i in i1];c2=[[cv(e2['covariance'][i][j]) for j in i2] for i in i2]
 c12=[[cv(q['dependence']['firstToSecondCovariance'][i][j]) for j in i2] for i in i1] if q['dependence']['kind']!='caller-declared-independent' else [[F(0)]*n for _ in range(n)]
 D=[[c1[i][j]+c2[i][j]-c12[i][j]-c12[j][i] for j in range(n)] for i in range(n)]
 d=[cv(e2['points'][i2[i]]['coordinate'])-cv(e1['points'][i1[i]]['coordinate']) for i in range(n)]
 refs=[next(i for i,m in enumerate(q['mapping']) if m['id']==id) for id in q['referenceIds']]
 w=[F(0)]*n
 if q['method']=='equal-reference-mean':local=[F(1,len(refs))]*len(refs)
 else:
  inv=inverse([[D[i][j] for j in refs] for i in refs]);raw=list(map(sum,inv));local=[x/sum(raw) for x in raw]
 for i,x in zip(refs,local):w[i]=x
 T=[[F(i==j)-w[j] for j in range(n)] for i in range(n)];shift=sum(x*y for x,y in zip(w,d));u=[x-shift for x in d];Dw=[sum(x*y for x,y in zip(r,w)) for r in D];v=sum(x*y for x,y in zip(w,Dw));cross=[sum(x*y for x,y in zip(r,Dw)) for r in T];cov=matmul(matmul(T,D),transpose(T))
 return dict(rawDifferences=d,differenceCovariance=D,referenceWeights=w,referenceShift=shift,referenceShiftVariance=v,displacements=u,displacementCovariance=cov,shiftDisplacementCovariance=cross,transformation=T)
def enc(x):
 if isinstance(x,F):return str(x.numerator)+'/'+str(x.denominator)
 if isinstance(x,list):return [enc(y) for y in x]
 if isinstance(x,dict):return {k:enc(v) for k,v in x.items()}
 return x
cases=[]
def add(name,q):cases.append(dict(name=name,request=q,expected=enc(oracle(q))))
for t in range(36):
 n=2+t%6;N=2*n
 L=[[F(rng.randint(-4,4),4) if j<i else F(rng.randint(2,6)) if j==i else F(0) for j in range(N)] for i in range(N)]
 J=matmul(L,transpose(L));d=[F(rng.randint(-100,100),8) for i in range(n)];refs=list(range(0,n,2));refs=refs if len(refs)>=2 else [0,1]
 for method in ['gls-reference-mean','equal-reference-mean']:
  q=make(n,J,d,refs,method);add(f'random-{t}-{method}',q)
  if t<4:
   unit=copy.deepcopy(q);unit['unit']='mm'
   for e in [unit['firstEpoch'],unit['secondEpoch']]:
    for p in e['points']:p['coordinate']*=1000
    e['covariance']=[[x*1000000 for x in r] for r in e['covariance']]
   unit['dependence']['firstToSecondCovariance']=[[x*1000000 for x in r] for r in unit['dependence']['firstToSecondCovariance']];add(f'unit-{t}-{method}',unit)
   shift=copy.deepcopy(q)
   for e in [shift['firstEpoch'],shift['secondEpoch']]:
    for p in e['points']:p['coordinate']+=1e8
   add(f'origin-{t}-{method}',shift)
   shift=copy.deepcopy(q)
   for p in shift['secondEpoch']['points']:p['coordinate']+=1000
   add(f'epochshift-{t}-{method}',shift)
   perm=copy.deepcopy(q);a=list(reversed(range(n)));b=list(range(1,n))+[0]
   for e,order in [(perm['firstEpoch'],a),(perm['secondEpoch'],b)]:e['points']=[e['points'][i] for i in order];e['covariance']=[[e['covariance'][i][j] for j in order] for i in order]
   c=perm['dependence']['firstToSecondCovariance'];perm['dependence']['firstToSecondCovariance']=[[c[i][j] for j in b] for i in a];perm['mapping'].reverse();perm['referenceIds'].reverse();add(f'permuted-{t}-{method}',perm)
# Independent unequal diagonal/nontrivial reference subset exact golden.
J=[[F(0) for j in range(8)] for i in range(8)]
for i,x in enumerate([1,4,9,16,1,4,9,16]):J[i][i]=F(x)
for method in ['gls-reference-mean','equal-reference-mean']:add('unequal-diagonal-'+method,make(4,J,[F(2),F(5),F(11),F(-3)],[0,1,2],method))
# Correlated reference has exact signed weights (3/2,-1/2,0), not clamped.
J=[[F(0) for j in range(6)] for i in range(6)]
for offset in [0,3]:
 for i,row in enumerate([[F(1,2),F(1),F(0)],[F(1),F(5,2),F(0)],[F(0),F(0),F(1)]]):
  for j,x in enumerate(row):J[offset+i][offset+j]=x
for method in ['gls-reference-mean','equal-reference-mean']:add('signed-reference-weights-'+method,make(3,J,[F(2),F(6),F(11)],[0,1],method))
(out/'cases.json').write_text(json.dumps({'seed':280620261,'arithmetic':'Fraction over actual binary64 inputs','cases':cases},indent=2)+'\n')
print(json.dumps({'generated':len(cases),'output':str(out/'cases.json')}))
