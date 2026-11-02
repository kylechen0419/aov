"""Build OW_OneClick.bat (self-contained, auto mode) and OW_OneClick.zip from OW_Boost.ps1.
Run: python3 build_oneclick.py
"""
import pathlib, zipfile

here = pathlib.Path(__file__).parent
ps = (here / "OW_Boost.ps1").read_bytes().decode("utf-8-sig").replace("\r\n", "\n")
ps = "\n".join(l for l in ps.split("\n") if not l.lower().startswith("#requires"))

header = r"""@echo off
REM Overwatch 2 + Discord one-click boost. Just double-click this file.
REM The PowerShell code at the end of this file is plain text - open in Notepad to inspect.
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator rights...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)
powershell -NoProfile -ExecutionPolicy Bypass -Command "$t=[IO.File]::ReadAllText('%~f0',[Text.Encoding]::UTF8); $i=$t.IndexOf('##PS_'+'BEGIN##'); & ([scriptblock]::Create($t.Substring($i))) -Auto"
pause
exit /b
##PS_BEGIN##
"""
out = (header + ps).replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")  # no BOM: cmd must read line 1 as ASCII
(here / "OW_OneClick.bat").write_bytes(out)

zi = zipfile.ZipInfo("OW_OneClick.bat", date_time=(2026, 11, 2, 0, 0, 0))
zi.compress_type = zipfile.ZIP_DEFLATED
with zipfile.ZipFile(here / "OW_OneClick.zip", "w") as z:
    z.writestr(zi, out)
print("built", len(out), "bytes")
