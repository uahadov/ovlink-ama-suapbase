import requests

BASE_URL = "http://localhost:3000"
FORGOT_PASSWORD_ENDPOINT = "/api/forgot-password"
TIMEOUT = 30
HEADERS = {"Content-Type": "application/json"}


def test_forgot_password_endpoint_validates_input():
    url = BASE_URL + FORGOT_PASSWORD_ENDPOINT

    test_cases = [
        # Missing email key
        ({}, 400),
        # Email key with empty string
        ({"email": ""}, 400),
        # Email key with invalid email format
        ({"email": "invalid-email-format"}, 400),
        # Email key with whitespace string
        ({"email": "   "}, 400),
        # Email key not a string (number)
        ({"email": 12345}, 400),
        # Email key null
        ({"email": None}, 400),
    ]

    for payload, expected_status in test_cases:
        try:
            response = requests.post(url, json=payload, headers=HEADERS, timeout=TIMEOUT)
        except requests.exceptions.RequestException as e:
            assert False, f"Request to forgot password endpoint failed: {e}"

        assert response.status_code == expected_status, (
            f"Expected HTTP {expected_status} but got {response.status_code} "
            f"for payload: {payload}. Response body: {response.text}"
        )


test_forgot_password_endpoint_validates_input()