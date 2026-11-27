@echo off
rem Builds napi_addon.node as a Debug build with a PDB (no node-gyp required).
rem Reuses node-api-headers bundled in ../node_modules/koffi/vendor/node-api-headers.
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
set "NAPI_DIR=..\node_modules\koffi\vendor\node-api-headers"
if not exist "%NAPI_DIR%\include\node_api.h" (
  echo node_api.h not found. Run npm install in examples\native-eval first.
  exit /b 1
)
if not exist build mkdir build
lib /nologo /def:"%NAPI_DIR%\def\node_api.def" /machine:x64 /out:build\node_api.lib
if errorlevel 1 exit /b 1
cl /nologo /LD /Od /Zi /EHsc /std:c++17 /DNODE_GYP_MODULE_NAME=napi_addon /I"%NAPI_DIR%\include" napi_addon.cpp /Fo:build\ /Fd:build\napi_addon.pdb /Fe:build\napi_addon.node build\node_api.lib /link /DEBUG
exit /b %errorlevel%
