$ErrorActionPreference = 'Stop'
$launchArgs = $args
Push-Location -LiteralPath $PSScriptRoot
try {
    $launcher = '.venv/Scripts/python.exe'
    if (-not (Test-Path -LiteralPath $launcher)) {
        if (Get-Command py -ErrorAction SilentlyContinue) { py -3 -m venv .venv }
        else { python -m venv .venv }
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & $launcher -c 'import fastapi, uvicorn, dotenv, numpy, pydantic'
    if ($LASTEXITCODE -ne 0) {
        & $launcher -m pip install -r requirements.txt
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    & $launcher -X utf8 scripts/start.py @launchArgs
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
