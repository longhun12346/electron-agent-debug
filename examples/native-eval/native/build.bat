@echo off
rem Builds native_eval.dll as a Debug build with a PDB. Run from any directory:
rem   cmd //c "C:\full\path\to\examples\native-eval\native\build.bat"
rem Set VCVARS to your vcvars64.bat if it is not found automatically.
setlocal
if defined VCVARS goto have
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
if defined VSROOT set "VCVARS=%VSROOT%\VC\Auxiliary\Build\vcvars64.bat"
:have
if not exist "%VCVARS%" (
  echo vcvars64.bat not found. Set VCVARS to its full path.
  exit /b 1
)
call "%VCVARS%" >nul
if errorlevel 1 exit /b 1
cd /d "%~dp0"
if not exist build mkdir build
cl /nologo /LD /Od /Zi /EHsc /std:c++17 native_eval.cpp /Fo:build\ /Fd:build\native_eval.pdb /Fe:build\native_eval.dll /link /DEBUG
exit /b %errorlevel%
