from pathlib import Path
import json,copy
import mpmath as mp
from fractions import Fraction as F
mp.mp.dps=120
p=Path(__file__).parent
base=json.loads((p/'cases.json').read_text())['cases'][0]['request']
def qmat(C,K=None,method='equal-reference-mean',refs=None):
 n=len(C);q=copy.deepcopy(base);q['method']=method
 for e,key in [(q['firstEpoch'],'a'),(q['secondEpoch'],'b')]:e['covariance']=copy.deepcopy(C);e['points']=[{'id':key+str(i),'coordinate':i if key=='a' else i+(i+1)*2} for i in range(n)]
 q['mapping']=[{'id':f'p{i}','firstPointId':f'a{i}','secondPointId':f'b{i}'} for i in range(n)];q['referenceIds']=[f'p{i}' for i in (refs or range(n))]
 q['dependence']={'kind':'caller-declared-independent','sourceAnchor':'explicit-independent'} if K is None else {'kind':'caller-declared-cross-covariance','sourceAnchor':'explicit-cross','firstToSecondCovariance':copy.deepcopy(K)}
 return q
def diag(n,x=1):return [[x if i==j else 0 for j in range(n)] for i in range(n)]
items=[]
def add(name,q,state,code=None,classification=None):
 item={'name':name,'request':q,'expected':{'outcome':state}}
 if code:item['expected']['code']=code
 if classification:item['expected']['classification']=classification
 if state!='invalid-input':
  n=len(q['mapping']);a=q['firstEpoch']['covariance'];b=q['secondEpoch']['covariance'];c=q['dependence'].get('firstToSecondCovariance',diag(n,0));M=mp.matrix([[mp.mpf(a[i][j]) if i<n and j<n else mp.mpf(c[i][j-n]) if i<n else mp.mpf(c[j][i-n]) if j<n else mp.mpf(b[i-n][j-n]) for j in range(2*n)] for i in range(2*n)]);item['jointMinimumEigenvalue120digit']=str(mp.eigsy(M,eigvals_only=True)[0])
 items.append(item)
N='numerically-positive-definite';U='semidefinite-or-unresolved-within-numerical-tolerance'
for method in ['equal-reference-mean','gls-reference-mean']:
 add('independent-'+method,qmat(diag(3),method=method),'calculated',classification=N)
 add('invalid-joint-despite-positive-D-'+method,qmat(diag(3),diag(3,-2),method),'unavailable','covariance-not-positive-semidefinite')
 add('zero-covariance-'+method,qmat(diag(3,0),method=method),'calculated' if method.startswith('equal') else 'unavailable',None if method.startswith('equal') else 'reference-covariance-rank-or-conditioning',U)
 C=[[1,1,0],[1,1,0],[0,0,1]]
 add('rank-one-reference-'+method,qmat(C,method=method,refs=[0,1]),'calculated' if method.startswith('equal') else 'unavailable',None if method.startswith('equal') else 'reference-covariance-rank-or-conditioning',U)
 C=[[1 if i==j else 0 for j in range(4)] for i in range(4)];C=[[x-.25 for x in r] for r in C]
 add('free-datum-all-'+method,qmat(C,method=method),'calculated' if method.startswith('equal') else 'unavailable',None if method.startswith('equal') else 'reference-covariance-rank-or-conditioning',U)
 add('free-datum-subset-'+method,qmat(C,method=method,refs=[0,2]),'calculated',classification=U)
 C=[[1,1+5e-11,0],[1+5e-11,1,0],[0,0,1]]
 add('near-indefinite-retained-'+method,qmat(C,method=method,refs=[0,2]),'calculated',classification=U)
 C=[[1,1-5e-11,0],[1-5e-11,1,0],[0,0,1]]
 add('near-PSD-positive-unresolved-'+method,qmat(C,method=method,refs=[0,2]),'calculated',classification=U)
 add('near-joint-negative-difference-variance-'+method,qmat(diag(3),diag(3,1+1e-12),method),'unavailable','numeric-range-or-resolution',U)
for correlation,state in [(1-1e-9,'calculated'),(1-1e-11,'unavailable')]:
 C=[[1,correlation,0],[correlation,1,0],[0,0,1]];add('gls-condition-'+str(correlation),qmat(C,method='gls-reference-mean',refs=[0,1]),state,'reference-covariance-rank-or-conditioning' if state=='unavailable' else None)
q=qmat(diag(3));q['firstEpoch']['covariance'][0][1]=1e-16;add('strict-asymmetry',q,'unavailable','covariance-not-symmetric')
q=qmat(diag(3));q['firstEpoch']['covariance'][0][0]=-1;add('negative-input-variance',q,'unavailable','covariance-not-positive-semidefinite')
q=qmat(diag(3));q['firstEpoch']['covariance'][0][0]=0;q['firstEpoch']['covariance'][0][1]=q['firstEpoch']['covariance'][1][0]=1e-20;add('zero-diagonal-nonzero-row',q,'unavailable','covariance-not-positive-semidefinite')
q=qmat(diag(3,1e-101));add('small-variance-domain',q,'unavailable','covariance-scale-outside-supported-domain')
q=qmat(diag(3));q['firstEpoch']['covariance'][0][0]=1e-13;add('variance-ratio-domain',q,'unavailable','covariance-scale-outside-supported-domain')
q=qmat(diag(3));q['firstEpoch']['points'][0]['coordinate']=5e-324;add('subnormal-coordinate',q,'unavailable','numeric-range-or-resolution')
q=qmat(diag(3));del q['dependence'];add('missing-dependence-not-defaulted',q,'invalid-input')
q=qmat(diag(3));q['referenceIds']=['p0'];add('single-reference-not-supported',q,'invalid-input')
q=qmat(diag(3));q['mapping'][0]['secondPointId']='b1';add('nonbijective-map',q,'invalid-input')
q=qmat(diag(3));q['referenceIds']=['p0','absent'];add('missing-reference-not-autoselected',q,'invalid-input')
q=qmat(diag(3));q['firstEpoch']['covarianceBasis']='relative-cofactor';add('cofactor-not-absolute-covariance',q,'invalid-input')
# 32 point capacity with exact diagonal model.
add('maximum-32-gls',qmat(diag(32),method='gls-reference-mean',refs=list(range(0,32,2))),'calculated',classification=N)
(p/'boundaries.json').write_text(json.dumps({'cases':items},indent=2)+'\n');print(json.dumps({'boundaries':len(items)}))
