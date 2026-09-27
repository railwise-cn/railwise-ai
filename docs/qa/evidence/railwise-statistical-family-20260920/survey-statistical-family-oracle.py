"""Independent fixtures: Python 3.12.7, mpmath==1.3.0; no product code imports.
Run: python survey-statistical-family-oracle.py > survey-statistical-family-oracle.json
All floating inputs are converted from their exact binary64 value, not ideal decimal.
"""
import json
import platform
import mpmath as mp

assert mp.__version__ == "1.3.0"
mp.mp.dps = 120

def tail(kind, value, df=None):
    x = mp.mpf(float(value))
    if kind == "normal":
        return mp.erfc(abs(x) / mp.sqrt(2))
    if kind == "student-t":
        return mp.betainc(mp.mpf(df)/2, mp.mpf(1)/2, 0, df/(df+x*x), regularized=True)
    return mp.gammainc(mp.mpf(df)/2, x/2, mp.inf, regularized=True)

def row(kind, value, df=None):
    p = tail(kind, value, df)
    return dict(kind=kind, statistic=value, df=df, p=mp.nstr(p,100), logP=mp.nstr(mp.log(p),100))

probabilities = [row("normal", v) for v in [0, 1e-12, 0.2, -0.2, 1, -1, 1.959963984540054, 3, 8, 26, 35, -35]]
for df in [1,2,3,10,30,100,999,1000]:
    for v in [0, 1e-12, 0.25, -0.25, 2, 10, 1e4, 1e16]:
        probabilities.append(row("student-t", v, df))
    for v in [0, 1e-12, 0.25, df, df+2-1e-8, df+2, df+2+1e-8, 100, 1000, 1e6]:
        probabilities.append(row("chi-square", v, df))

critical = []
for kind,df,ceiling in [("normal",None,35),("student-t",1,1e16),("student-t",2,1e16),("student-t",10,1e16),("student-t",1000,1e16),("chi-square",1,1e6),("chi-square",2,1e6),("chi-square",10,1e6),("chi-square",1000,1e6)]:
    for alpha,count in [(0.05,1),(0.05,4),(0.5,256),(1e-12,256)]:
        effective = float(alpha/count)
        target = mp.mpf(effective)
        lo,hi = mp.mpf(0),mp.mpf(ceiling)
        # Keep the inverse calculation high precision throughout (tail() deliberately
        # emulates binary64 only for the independently supplied statistic fixtures).
        for _ in range(400):
            mid=(lo+hi)/2
            if kind=="normal": p=mp.erfc(mid/mp.sqrt(2))
            elif kind=="student-t": p=mp.betainc(mp.mpf(df)/2,mp.mpf(1)/2,0,df/(df+mid*mid),regularized=True)
            else: p=mp.gammainc(mp.mpf(df)/2,mid/2,mp.inf,regularized=True)
            if p>target: lo=mid
            else: hi=mid
        critical.append(dict(kind=kind,df=df,alpha=alpha,familySize=count,memberAlpha=effective,critical=mp.nstr((lo+hi)/2,100)))

print(json.dumps(dict(provenance=dict(python=platform.python_version(),mpmath=mp.__version__,decimalPrecision=mp.mp.dps,reference="mpmath special functions independent of TypeScript Lanczos/Lentz implementation",inputInterpretation="exact binary64 scalar and rounded binary64 alpha/familySize"),probabilities=probabilities,critical=critical),indent=2,allow_nan=False))
