@echo off

REM Add something here that checks to see if node is installed

REM cd "C:\RetroBat\emulators\jsgamelauncher\"
cd /d "C:\RetroBat\emulators\jsgamelauncher\"
if exist package.json (
  if not exist node_modules (
    npm install
  )
)

node index.js %*
