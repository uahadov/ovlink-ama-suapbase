import requests

BASE_URL = "http://localhost:3000"
SHORTEN_ENDPOINT = "/api/shorten"
TIMEOUT = 30

def test_shorten_api_validates_empty_payload():
    url = BASE_URL + SHORTEN_ENDPOINT
    headers = {"Content-Type": "application/json"}
    try:
        response = requests.post(url, headers=headers, json=None, timeout=TIMEOUT)
    except requests.exceptions.RequestException as e:
        assert False, f"Request to {url} failed with exception: {e}"

    # Expecting client error due to empty payload
    assert response.status_code >= 400, f"Expected error status code for empty payload but got {response.status_code}"
    # Optionally check JSON error message if any:
    try:
        json_body = response.json()
        assert "error" in json_body or "message" in json_body, "Response JSON should contain error or message key"
    except ValueError:
        # Response is not JSON, this might be acceptable if API sends text errors
        pass

test_shorten_api_validates_empty_payload()