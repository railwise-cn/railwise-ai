#!/usr/bin/env python3
"""Independent exact GLS / generalized signed w oracle.
Only stdlib fractions + decimal; imports no product code or scientific package.
Residual convention: observed minus adjusted, v = y - A xhat.
C is the full known a-priori covariance, not a relative weight/cofactor matrix.
"""
from fractions import Fraction as F
from decimal import Decimal, localcontext
import json, platform
from pathlib import Path


def matrix(rows): return [[F(value) for value in row] for row in rows]
def transpose(a): return [list(row) for row in zip(*a)]
def multiply(a, b):
    bt = transpose(b)
    return [[sum((x*y for x,y in zip(row,col)), F(0)) for col in bt] for row in a]
def subtract(a, b): return [[x-y for x,y in zip(ar,br)] for ar,br in zip(a,b)]
def scale(a, k): return [[F(k)*x for x in row] for row in a]
def eye(n): return [[F(i==j) for j in range(n)] for i in range(n)]
def inverse(a):
    n = len(a)
    augmented = [list(row)+unit for row,unit in zip(a,eye(n))]
    for col in range(n):
        pivot = next((row for row in range(col,n) if augmented[row][col]), None)
        if pivot is None: raise ValueError('singular exact matrix')
        augmented[pivot],augmented[col] = augmented[col],augmented[pivot]
        divisor = augmented[col][col]
        augmented[col] = [x/divisor for x in augmented[col]]
        for row in range(n):
            if row == col: continue
            factor = augmented[row][col]
            augmented[row] = [x-factor*y for x,y in zip(augmented[row],augmented[col])]
    return [row[n:] for row in augmented]
def determinant(a):
    if not a: return F(1)
    return sum(((-1)**j * a[0][j] * determinant([row[:j]+row[j+1:] for row in a[1:]]) for j in range(len(a))),F(0))
def scalar(v):
    with localcontext() as context:
        context.prec = 80
        return Decimal(v.numerator)/Decimal(v.denominator)
def decimal_w(numerator, variance):
    if variance == 0: return None
    with localcontext() as context:
        context.prec = 70
        return str(scalar(numerator)/scalar(variance).sqrt())
def quadratic(c, a): return multiply(multiply(transpose(c),a),c)[0][0]
def solve(A,y,C,directions):
    A,y,C=matrix(A),matrix(y),matrix(C)
    assert C==transpose(C)
    principal = [determinant([row[:k] for row in C[:k]]) for k in range(1,len(C)+1)]
    assert all(x>0 for x in principal), 'C must be positive definite'
    W=inverse(C); At=transpose(A)
    N=multiply(multiply(At,W),A); Ninv=inverse(N)
    x=multiply(multiply(multiply(Ninv,At),W),y)
    fitted=multiply(A,x); v=subtract(y,fitted)
    Cvv=subtract(C,multiply(multiply(A,Ninv),At))
    M=subtract(W,multiply(multiply(multiply(multiply(W,A),Ninv),At),W))
    assert multiply(multiply(W,Cvv),W)==M
    assert multiply(multiply(At,W),v)==matrix([[0] for _ in range(len(A[0]))])
    out={}
    for name,c in directions.items():
        c=matrix(c)
        numerator=multiply(multiply(transpose(c),W),v)[0][0]
        variance=quadratic(c,M)
        assert variance>=0
        if variance==0: assert numerator==0
        out[name]={'c':c,'numerator':numerator,'denominatorSquared':variance,
            'status':'undetectable' if variance==0 else 'available',
            'w':decimal_w(numerator,variance)}
    return {'A':A,'y':y,'C':C,'covarianceLeadingPrincipalMinors':principal,
        'xhat':x,'observedMinusAdjusted':v,'Cvv':Cvv,'precisionResidualProjector':M,
        'residualDegreesOfFreedom':len(A)-len(A[0]),'weightedResidualEnergy':quadratic(v,W),'directions':out}
def permute_rows(a,indices): return [a[i] for i in indices]
def permute_square(a,indices): return [[a[i][j] for j in indices] for i in indices]
def assert_same_w(left,right,direction='test'):
    assert left['directions'][direction]['w']==right['directions'][direction]['w']
def encode(value):
    if isinstance(value,F): return str(value)
    raise TypeError(type(value).__name__)

gold_A=[[1],[1],[1]]; gold_y=[[0],[11],[2]]; gold_C=[[4,1,0],[1,9,0],[0,0,1]]
gold_directions={'e1':[[1],[0],[0]],'e2':[[0],[1],[0]],'e3':[[0],[0],[1]],'column-space':[[1],[1],[1]],'zero-direction':[[0],[0],[0]]}
gold=solve(gold_A,gold_y,gold_C,gold_directions)
assert gold['xhat']==matrix([['103/46']])
assert gold['observedMinusAdjusted']==matrix([['-103/46'],['403/46'],['-11/46']])
expected={'e1':(F(-19),F(115)),'e2':(F(49),F(230)),'e3':(F(-11),F(506))}
for name,(num,var) in expected.items():
    # Exact ratio and sign, no decimal rounding asserted as mathematical equality.
    actual=gold['directions'][name]
    assert actual['numerator']**2/actual['denominatorSquared']==num**2/var
    assert (actual['numerator']>0)==(num>0)

A=[[1,0],[1,1],[1,2],[1,4]]; y=[[0],[3],[1],[8]]
C=[[4,1,0,0],[1,9,1,0],[0,1,4,1],[0,0,1,1]]; c=[[1],[0],[-1],[2]]
base=solve(A,y,C,{'test':c,'intercept':[[1],[1],[1],[1]],'slope':[[0],[1],[2],[4]],'linear-combination':[[2],[5],[8],[14]]})
indices=[2,0,3,1]
row_sorted=solve(permute_rows(A,indices),permute_rows(y,indices),permute_square(C,indices),{'test':permute_rows(c,indices)})
assert base['xhat']==row_sorted['xhat']; assert_same_w(base,row_sorted)
column_sorted=solve([[row[1],row[0]] for row in A],y,C,{'test':c})
assert column_sorted['xhat']==list(reversed(base['xhat'])); assert_same_w(base,column_sorted)
wrong_c_order=solve(permute_rows(A,indices),permute_rows(y,indices),permute_square(C,indices),{'test':c})
assert wrong_c_order['directions']['test']['w']!=base['directions']['test']['w']
negated=solve(A,y,C,{'test':scale(c,-1)})
assert negated['directions']['test']['numerator']==-base['directions']['test']['numerator']
assert negated['directions']['test']['denominatorSquared']==base['directions']['test']['denominatorSquared']
scaled_c=solve(A,y,C,{'test':scale(c,7)})
assert_same_w(base,scaled_c)
# Units m -> mm, parameter coordinates also expressed in mm; c remains a dimensionless bias direction.
unit_scale=F(1000)
unit_scaled=solve(A,scale(y,unit_scale),scale(C,unit_scale**2),{'test':c})
assert unit_scaled['xhat']==scale(base['xhat'],unit_scale); assert_same_w(base,unit_scaled)
# Equivalent representation keeping parameter units unchanged and scaling model rows + physical direction.
row_unit_scaled=solve(scale(A,unit_scale),scale(y,unit_scale),scale(C,unit_scale**2),{'test':scale(c,unit_scale)})
assert row_unit_scaled['xhat']==base['xhat']; assert_same_w(base,row_unit_scaled)
# Full invertible row-unit reexpression: y'=D y, A'=D A, C'=D C D, c'=D c.
D=matrix([[1000,0,0,0],[0,'1/1000',0,0],[0,0,10,0],[0,0,0,1]])
mixed_units=solve(multiply(D,matrix(A)),multiply(D,matrix(y)),multiply(multiply(D,matrix(C)),D),{'test':multiply(D,matrix(c))})
assert mixed_units['xhat']==base['xhat']; assert_same_w(base,mixed_units)
# Scaling ONLY covariance by positive k changes statistical signal: w' = w/sqrt(k).
covariance_scaled=solve(A,y,scale(C,9),{'test':c})
assert covariance_scaled['xhat']==base['xhat']
assert covariance_scaled['directions']['test']['numerator']==base['directions']['test']['numerator']/9
assert covariance_scaled['directions']['test']['denominatorSquared']==base['directions']['test']['denominatorSquared']/9
assert covariance_scaled['weightedResidualEnergy']==base['weightedResidualEnergy']/9
# Adding a model-space component to the direction does not change the tested residual-space alternative.
model_direction = multiply(matrix(A), matrix([[100],[-50]]))
equivalent_direction = solve(A,y,C,{'test':[[x[0]+a[0]] for x,a in zip(c,model_direction)]})
assert_same_w(base,equivalent_direction)
# Adding a model-representable observation shift changes fitted parameters, not the statistic.
beta=matrix([[3],[-2]])
model_shift=solve(A,[[x[0]+a[0]] for x,a in zip(y,multiply(matrix(A),beta))],C,{'test':c})
assert model_shift['observedMinusAdjusted']==base['observedMinusAdjusted']; assert_same_w(base,model_shift)

output={
 'oracle':'independent-python-fraction-gls-w-1','python':platform.python_version(),
 'dependencies':'Python standard library only; no product modules, NumPy, SciPy or shared fixture generator',
 'residualConvention':'observed-minus-adjusted',
 'assumptions':{'C':'full known a-priori covariance, not estimated from these residuals','model':'fixed linear A of full column rank; symmetric positive definite C','test':'specified scalar bias direction c; no selection, normal tail, family correction or quality decision','distribution':'w is N(0,1) only under correct mean model and known Gaussian covariance; mean/covariance alone do not imply normality','professionalSignoff':False},
 'goldenAnalyticExpressions':{'xhat':'103/46','e1':'-19/sqrt(115)','e2':'49/sqrt(230)','e3':'-sqrt(11/46)'},
 'golden':gold,
 'invarianceBase':base,
 'rowPermutation':{'permutationZeroBased':indices,'result':row_sorted},
 'parameterColumnPermutation':{'permutationZeroBased':[1,0],'result':column_sorted},
 'negativeControlWrongDirectionPermutation':wrong_c_order,
 'directionNegation':negated,'directionPositiveScale7':scaled_c,
 'units1000ParameterUnitsChanged':unit_scaled,
 'units1000ParameterUnitsUnchanged':row_unit_scaled,
 'mixedRowUnitReexpression':mixed_units,
 'priorCovarianceScale9':covariance_scaled,
 'directionPlusModelSpace':equivalent_direction,
 'modelSpaceShift':model_shift,
 'assertions':'All exact-rational identities passed; decimal w strings use 70-digit decimal arithmetic.'}
path=Path(__file__).with_name('fraction_oracle_output.json')
path.write_text(json.dumps(output,default=encode,ensure_ascii=False,indent=2)+'\n')
print(path)
for name,entry in gold['directions'].items(): print(name,entry['numerator'],entry['denominatorSquared'],entry['status'],entry['w'])
print('base x:',[str(row[0]) for row in base['xhat']])
for name,value in [('base',base),('row-permuted',row_sorted),('columns-permuted',column_sorted),('wrong-c-permutation',wrong_c_order),('negated',negated),('scaled-units',unit_scaled),('covariance-x9',covariance_scaled)]:
 print(name,value['directions']['test']['w'])
print('All exact-rational assertions passed.')
