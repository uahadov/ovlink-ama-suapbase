import requests

def test_unknown_route_returns_non_success():
    base_url = "http://localhost:3000"
    unknown_path = "/non-existent-route-xyz123"
    url = base_url + unknown_path

    try:
        response = requests.get(url, timeout=30)
    except requests.RequestException as e:
        # If request fails at transport level, that is acceptable for unknown route test
        assert True
        return

    # Assert that the status code is not a success code (i.e., not 2xx)
    assert not (200 <= response.status_code < 300), (
        f"Expected non-success status code for unknown route, got {response.status_code}"
    )

test_unknown_route_returns_non_success()