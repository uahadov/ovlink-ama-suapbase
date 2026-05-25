import requests

BASE_URL = "http://localhost:3000"
TIMEOUT = 30

def test_domain_api_rejects_anonymous_caller():
    # Example of a session-protected domain API endpoint (assumed /api/custom-domains as domain-related API)
    url = f"{BASE_URL}/api/custom-domains"
    headers = {
        "Accept": "application/json"
    }

    try:
        response = requests.get(url, headers=headers, timeout=TIMEOUT)
    except requests.RequestException as e:
        assert False, f"Request failed with exception: {e}"

    # Expecting unauthorized access (401) or forbidden (403) due to anonymous call without session/auth token
    assert response.status_code in (401, 403), (
        f"Expected 401 Unauthorized or 403 Forbidden, got {response.status_code}. "
        f"Response body: {response.text}"
    )

test_domain_api_rejects_anonymous_caller()