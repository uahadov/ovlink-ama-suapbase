import requests

def test_shorten_api_validates_payload():
    base_url = "http://localhost:3000"
    url = f"{base_url}/api/shorten"
    headers = {
        "Content-Type": "application/json"
    }
    try:
        response = requests.post(url, json={}, headers=headers, timeout=30)
    except requests.RequestException as e:
        assert False, f"Request failed: {e}"
    else:
        # Expecting a client error due to empty payload, typically 400 Bad Request
        assert response.status_code >= 400 and response.status_code < 500, \
            f"Expected client error status for empty payload, got {response.status_code}"
        # Optionally check for error message in response if it's JSON
        try:
            json_resp = response.json()
            assert "error" in json_resp or "message" in json_resp, \
                "Response JSON does not contain error or message key"
        except ValueError:
            # Response not JSON, accept as valid error response as well
            pass

test_shorten_api_validates_payload()