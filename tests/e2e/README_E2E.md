# Omega E2E Tests

Automated end-to-end tests for Project Omega.

## Setup

```bash
cd tests/e2e
npm install
```

Or, add these as devDependencies to the main controller-api:
```bash
cd controller-api
npm install --save-dev adm-zip form-data axios
```

## Configuration

Set these environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `OMEGA_API_URL` | `http://localhost:3000` | Controller API URL |
| `OMEGA_ADMIN_EMAIL` | `admin@example.com` | Admin login email |
| `OMEGA_ADMIN_PASSWORD` | `changeme123` | Admin login password |
| `OMEGA_TEST_DOMAIN` | `test-e2e-{timestamp}.omega.local` | Test domain |
| `OMEGA_TIMEOUT_MS` | `180000` | Max wait for deployment (3 min) |

## Run

```bash
# All tests
npm run test:e2e

# Individual tests
node run-e2e.js
```

## Tests

| # | Test | Description |
|---|------|-------------|
| 1 | Admin Login | Logs in, gets JWT token |
| 2 | Node Availability | Checks online/Docker/Tailscale nodes |
| 3 | Static Deploy | Uploads ZIP, waits for active, verifies |
| 4 | Python Deploy | Uploads Python Flask app, deploys via Docker |
| 5 | Container Logs | Gets logs from deployed container |
| 6 | Failover | Verifies website active node and Caddy route |
| 7 | Dashboard | Checks dashboard stats are populated |

## Output

- Console: PASS/FAIL per test with timing
- `results/latest.json`: Detailed results for CI
