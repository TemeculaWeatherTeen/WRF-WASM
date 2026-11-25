#!/usr/bin/env python3
"""Repoint a configure.wrf generated for gfortran/gcc (serial) at the wasm toolchain.

WRF's `./configure` only knows native compilers, so we let it write a normal
gfortran-serial configure.wrf and then rewrite the toolchain variables.
Anything that must still run on the build machine (the registry and other code
generators) is built with CC_TOOLS, which stays a native gcc.
"""
import re
import sys

path = sys.argv[1]
text = open(path).read()


def setvar(name, value):
    global text
    pat = re.compile(r"^%s[ \t]*=.*$" % re.escape(name), re.M)
    if pat.search(text):
        text = pat.sub(lambda m: f"{name} = {value}", text, count=1)
    else:
        text += f"\n{name} = {value}\n"


setvar("SFC", "flang-wasm")
setvar("SCC", "emcc")
setvar("CCOMP", "emcc")
setvar("DM_FC", "flang-wasm")
setvar("DM_CC", "emcc")
setvar("CC_TOOLS", "gcc")              # host tools (registry etc.) must run natively
setvar("AR", "emar")
setvar("RANLIB", "emranlib")
setvar("FCOPTIM", "-O2")
setvar("FCREDUCEDOPT", "$(FCOPTIM)")
setvar("FCDEBUG", "")
setvar("FORMAT_FREE", "-ffree-form")           # flang has no -ffree-line-length-none; free form is not length-limited
setvar("BYTESWAPIO", "-fconvert=big-endian")   # RRTMG/other data files are big-endian
setvar("CFLAGS_LOCAL", "-w -O2 -c")
setvar("LDFLAGS_LOCAL", "")

# gfortran-only / host-only definitions
text = text.replace("-DNONSTANDARD_SYSTEM_SUBR", "")
text = re.sub(r"-frecord-marker=\d", "", text)

open(path, "w").write(text)
print("patched", path)
for key in ("SFC", "SCC", "CCOMP", "CC_TOOLS", "AR", "FCOPTIM", "FORMAT_FREE", "BYTESWAPIO", "LIB_EXTERNAL"):
    m = re.search(r"^%s[ \t]*=.*$" % key, text, re.M)
    print("  ", m.group(0) if m else f"{key}: (not set)")
