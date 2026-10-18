#!/usr/bin/env python3
"""Collect a private local benchmark corpus from a public Instagram creator feed."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import time
from pathlib import Path
from typing import Any

import requests


PROFILE_QUERY_NAME = "PolarisLoggedOutDesktopWWWProfilePostsTabContentQuery"
POST_QUERY_NAME = "PolarisPostRootQuery"
DEFAULT_PROFILE_DOC_ID = "27126064893724785"
DEFAULT_POST_DOC_ID = "27619468827737957"
GRAPHQL_URL = "https://www.instagram.com/api/graphql"
USER_AGENT = "Mozilla/5.0"


def extract_lsd(profile_html: str) -> str:
    match = re.search(r'"LSD",\[\],\{"token":"([^"]+)"', profile_html)
    if not match:
        raise RuntimeError("Instagram profile bootstrap did not expose an LSD request token")
    return match.group(1)


def first_caption_line(caption: str, fallback: str) -> str:
    for line in caption.splitlines():
        cleaned = re.sub(r"\s+", " ", line).strip(" .")
        if cleaned:
            return cleaned[:180]
    cleaned_fallback = re.sub(r"^Video by .*? on [A-Za-z]+ \d{2}, \d{4}\.\s*", "", fallback).strip()
    return cleaned_fallback[:180] or "Untitled creator reel"


def parse_visible_count(value: Any) -> int:
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return int(value)
    if not isinstance(value, str):
        return 0
    normalized = value.strip().replace(",", "").upper()
    match = re.fullmatch(r"([0-9]+(?:\.[0-9]+)?)([KMB]?)", normalized)
    if not match:
        return 0
    multiplier = {"": 1, "K": 1_000, "M": 1_000_000, "B": 1_000_000_000}[match.group(2)]
    return round(float(match.group(1)) * multiplier)


def link_or_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        return
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


class PublicInstagramCollector:
    def __init__(self, handle: str, profile_doc_id: str, post_doc_id: str) -> None:
        self.handle = handle.lstrip("@")
        self.profile_doc_id = profile_doc_id
        self.post_doc_id = post_doc_id
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": USER_AGENT})
        response = requests.get(
            f"https://www.instagram.com/{self.handle}/",
            headers={"User-Agent": USER_AGENT},
            timeout=30,
        )
        response.raise_for_status()
        self.lsd = extract_lsd(response.text)

    def graphql(self, query_name: str, doc_id: str, variables: dict[str, Any]) -> dict[str, Any]:
        headers = {
            "x-fb-friendly-name": query_name,
            "x-fb-lsd": self.lsd,
            "x-ig-app-id": "936619743392459",
        }
        data = {
            "av": "0",
            "__user": "0",
            "__a": "1",
            "__req": "1",
            "__comet_req": "7",
            "lsd": self.lsd,
            "fb_api_caller_class": "RelayModern",
            "fb_api_req_friendly_name": query_name,
            "variables": json.dumps(variables, separators=(",", ":")),
            "server_timestamps": "true",
            "doc_id": doc_id,
        }
        response = None
        for attempt in range(1, 5):
            try:
                response = requests.post(
                    GRAPHQL_URL,
                    headers={**headers, "User-Agent": USER_AGENT},
                    data=data,
                    timeout=45,
                )
                response.raise_for_status()
                payload = response.json()
                break
            except (requests.RequestException, requests.JSONDecodeError) as error:
                if attempt == 4:
                    preview = response.text[:180].replace("\n", " ") if response is not None else str(error)
                    raise RuntimeError(f"Instagram {query_name} failed after four attempts: {preview}") from error
                time.sleep(attempt * 0.75)
        critical = [error for error in payload.get("errors", []) if error.get("severity") == "CRITICAL"]
        if critical:
            raise RuntimeError(f"Instagram {query_name} failed: {critical[0].get('message', 'critical error')}")
        return payload

    def timeline(self, minimum_unique: int, known_shortcodes: set[str]) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        discovered = set(known_shortcodes)
        after = None
        while len(results) < minimum_unique:
            variables: dict[str, Any] = {"first": 12, "username": self.handle}
            if after:
                variables["after"] = after
            payload = self.graphql(PROFILE_QUERY_NAME, self.profile_doc_id, variables)
            connection = payload["data"]["xig_user_by_username"]["polaris_ordered_timeline_connection"]
            for edge in connection.get("edges", []):
                node = edge.get("node", {})
                shortcode = node.get("code")
                if not shortcode or shortcode in discovered or node.get("product_type") != "clips":
                    continue
                discovered.add(shortcode)
                results.append(node)
            page_info = connection.get("page_info", {})
            next_cursor = page_info.get("end_cursor")
            if not page_info.get("has_next_page") or not next_cursor or next_cursor == after:
                break
            after = next_cursor
            time.sleep(0.15)
        if len(results) < minimum_unique:
            raise RuntimeError(f"Only found {len(results)} new public reels; needed {minimum_unique}")
        return results[:minimum_unique]

    def reel(self, shortcode: str) -> dict[str, Any]:
        payload = self.graphql(POST_QUERY_NAME, self.post_doc_id, {
            "shortcode": shortcode,
            "__relay_internal__pv__PolarisShortDramaEnabledrelayprovider": False,
            "__relay_internal__pv__PolarisMultiCaptionCarouselEnabledrelayprovider": False,
        })
        items = payload["data"]["xdt_api__v1__media__shortcode__web_info"].get("items", [])
        if not items:
            raise RuntimeError(f"Instagram returned no public media for {shortcode}")
        return items[0]

    def download(self, url: str, destination: Path) -> None:
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and destination.stat().st_size > 100_000:
            return
        partial = destination.with_suffix(destination.suffix + ".part")
        for attempt in range(1, 5):
            try:
                with self.session.get(url, stream=True, timeout=120) as response:
                    response.raise_for_status()
                    with partial.open("wb") as output:
                        for chunk in response.iter_content(chunk_size=1024 * 1024):
                            if chunk:
                                output.write(chunk)
                break
            except requests.RequestException:
                partial.unlink(missing_ok=True)
                if attempt == 4:
                    raise
                time.sleep(attempt)
        partial.replace(destination)


def metric(item: dict[str, Any], *keys: str) -> int:
    for key in keys:
        value = parse_visible_count(item.get(key))
        if value:
            return value
    return 0


def best_video_version(item: dict[str, Any]) -> dict[str, Any]:
    versions = item.get("video_versions", [])
    if not versions:
        raise RuntimeError(f"No progressive video rendition for {item.get('code', 'unknown reel')}")
    return max(versions, key=lambda version: int(version.get("width", 0)) * int(version.get("height", 0)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--handle", required=True)
    parser.add_argument("--existing-manifest", type=Path, required=True)
    parser.add_argument("--existing-source-dir", type=Path, required=True)
    parser.add_argument("--target-count", type=int, default=100)
    parser.add_argument("--output-manifest", type=Path, required=True)
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--profile-doc-id", default=DEFAULT_PROFILE_DOC_ID)
    parser.add_argument("--post-doc-id", default=DEFAULT_POST_DOC_ID)
    parser.add_argument("--metadata-only", action="store_true")
    args = parser.parse_args()

    existing_manifest = json.loads(args.existing_manifest.read_text())
    existing = [entry for entry in existing_manifest["entries"] if int(entry.get("rank", 0)) <= 20]
    if args.target_count < len(existing):
        raise ValueError("target-count cannot be smaller than the preserved benchmark")
    collector = PublicInstagramCollector(args.handle, args.profile_doc_id, args.post_doc_id)
    additions = collector.timeline(args.target_count - len(existing), {entry["shortcode"] for entry in existing})
    entries: list[dict[str, Any]] = []

    for rank, entry in enumerate(existing, start=1):
        filename = f"{rank:03d}-{entry['shortcode']}.mp4"
        source = args.existing_source_dir / entry["file"]
        if not args.metadata_only:
            link_or_copy(source, args.source_dir / filename)
        entries.append({**entry, "rank": rank, "file": filename, "sourceGroup": "preserved-top-20"})

    for rank, node in enumerate(additions, start=len(existing) + 1):
        shortcode = node["code"]
        item = collector.reel(shortcode)
        caption = ((item.get("caption") or {}).get("text") or (node.get("caption") or {}).get("text") or "").strip()
        accessibility = item.get("accessibility_caption") or node.get("accessibility_caption") or ""
        filename = f"{rank:03d}-{shortcode}.mp4"
        version = best_video_version(item)
        entry = {
            "rank": rank,
            "shortcode": shortcode,
            "title": first_caption_line(caption, accessibility),
            "caption": caption,
            "url": f"https://www.instagram.com/reel/{shortcode}/",
            "file": filename,
            "publishedAt": item.get("taken_at"),
            "views": metric(item, "play_count", "video_view_count", "view_count"),
            "likes": metric(item, "like_count"),
            "comments": metric(item, "comment_count"),
            "sourceGroup": "public-timeline-expansion",
            "sourceDimensions": {"width": version.get("width"), "height": version.get("height")},
        }
        entries.append(entry)
        if not args.metadata_only:
            collector.download(version["url"], args.source_dir / filename)
        print(f"Collected {rank:03d}/{args.target_count}: {shortcode} - {entry['title']}", flush=True)
        time.sleep(0.15)

    output = {
        "schemaVersion": 2,
        "creator": existing_manifest["creator"],
        "scope": {
            "ranking": "Preserved SocialPruf top 20 followed by the newest unique public timeline reels",
            "purpose": "Private production-pattern analysis; source media is not redistributed or used in generated posts.",
            "targetCount": args.target_count,
            "profileQuery": PROFILE_QUERY_NAME,
            "profileQueryDocumentId": args.profile_doc_id,
            "postQuery": POST_QUERY_NAME,
            "postQueryDocumentId": args.post_doc_id,
            "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        },
        "sources": existing_manifest.get("sources", []),
        "entries": entries,
    }
    args.output_manifest.parent.mkdir(parents=True, exist_ok=True)
    args.output_manifest.write_text(json.dumps(output, indent=2) + "\n")
    print(f"Wrote {len(entries)} entries to {args.output_manifest}")


if __name__ == "__main__":
    main()
