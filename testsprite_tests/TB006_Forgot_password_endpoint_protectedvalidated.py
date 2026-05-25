import requests

def test_forgot_password_endpoint_rejects_invalid_post():
    base_url = "http://localhost:3000"
    url = f"{base_url}/api/forgot-password"
    headers = {
        "Content-Type": "application/json"
    }
    # Intentionally send an invalid/bad payload (e.g., missing required "email" field)
    bad_payload = {}

    try:
        response = requests.post(url, json=bad_payload, headers=headers, timeout=30)
    except requests.RequestException as e:
        assert False, f"Request to forgot-password endpoint failed: {e}"

    # The endpoint should reject the request as bad or unauthenticated with an error status code (e.g., 400 or 422)
    assert response.status_code >= 400, f"Expected client error status code, got {response.status_code}"

    # The response content should indicate the missing required form data or invalid request
    try:
        resp_json = response.json()
    except ValueError:
        # If no JSON response, fallback to asserting presence of error in text
        resp_json = None

    if resp_json:
        assert (
            "error" in resp_json or "message" in resp_json
        ), f"Expected error message in response JSON, got: {resp_json}"
    else:
        # If not JSON, check for generic error text presence
        error_indicators = ["error", "invalid", "missing", "required"]
        response_text = response.text.lower()
        assert any(word in response_text for word in error_indicators), (
            f"Expected error indicator in response text, got: {response.text}"
        )

test_forgot_password_endpoint_rejects_invalid_post()