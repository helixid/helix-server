# StatusListCredential construction, matching helix-sdk-js's
# core/status-list-schema.ts buildStatusListCredential() exactly (including
# its slightly odd `id` shape -- ".../v1/status-list/<listId>" even though
# this demo's SPs actually serve the list at "/status-list/<listId>". That
# mismatch is harmless: verifiers resolve the list via the URL carried in
# credentialStatus.statusListUrl, never by parsing this `id` field.
#
# Bitstring encode/decode itself is reused from helix_cli.status_list
# (ported 1:1 from the same JS source this demo's TS version calls into).

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from helix_cli.status_list import create_status_list, get_bit, set_bit  # noqa: F401

VC_CONTEXTS = [
    "https://www.w3.org/ns/credentials/v2",
    "https://www.w3.org/ns/credentials/status/v1",
]


def build_status_list_credential(
    list_id: str, encoded_list: str, issuer_did: str, api_base_url: str
) -> Dict[str, Any]:
    return {
        "@context": list(VC_CONTEXTS),
        "id": f"{api_base_url}/v1/status-list/{list_id}",
        "type": ["VerifiableCredential", "BitstringStatusListCredential"],
        "issuer": issuer_did,
        "validFrom": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "credentialSubject": {
            "id": f"{api_base_url}/v1/status-list/{list_id}#list",
            "type": "BitstringStatusList",
            "statusPurpose": "revocation",
            "encodedList": encoded_list,
        },
    }
