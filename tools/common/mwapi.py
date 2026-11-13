"""A minimal MediaWiki API client. Stdlib only.

It exists for four things that would otherwise be repeated in every script:

* a polite rate limit and an honest User-Agent;
* detecting a Cloudflare challenge — Fandom returns HTML instead of JSON,
  and without an explicit check it looks like a mysterious JSON parse error;
* batches of 50 pages and ``continue`` handling;
* Cargo queries with pagination (at most 500 rows at a time).
"""

from __future__ import annotations

import gzip
import json
import time
import urllib.error
import urllib.parse
import urllib.request

USER_AGENT = (
    "AndresBench/0.1 (Endfield damage calculator; "
    "+https://github.com/andresbench/calculator)"
)

# MediaWiki accepts at most 50 titles per request for ordinary users.
TITLES_PER_REQUEST = 50
# The Cargo API cap: limit=500 (highmax=5000 only for flagged bots).
CARGO_PAGE_SIZE = 500


class WikiError(RuntimeError):
    """An API or network error."""


class BlockedError(WikiError):
    """Site protection returned HTML instead of JSON (Cloudflare and the like)."""


class MWClient:
    def __init__(
        self,
        api_url: str,
        *,
        delay: float = 1.0,
        timeout: int = 45,
        max_retries: int = 4,
        user_agent: str = USER_AGENT,
    ) -> None:
        self.api_url = api_url
        self.delay = delay
        self.timeout = timeout
        self.max_retries = max_retries
        self.user_agent = user_agent
        self._last_request = 0.0
        self.request_count = 0

    # ------------------------------------------------------------------ HTTP

    def _throttle(self) -> None:
        wait = self.delay - (time.monotonic() - self._last_request)
        if wait > 0:
            time.sleep(wait)
        self._last_request = time.monotonic()

    def _raw_request(self, params: dict) -> bytes:
        query = urllib.parse.urlencode(params, doseq=True)
        # Long title lists do not fit in a URL — switch to POST.
        if len(query) > 1800:
            request = urllib.request.Request(
                self.api_url, data=query.encode("utf-8")
            )
        else:
            request = urllib.request.Request(f"{self.api_url}?{query}")
        request.add_header("User-Agent", self.user_agent)
        request.add_header("Accept-Encoding", "gzip")

        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            body = response.read()
            if response.headers.get("Content-Encoding") == "gzip":
                body = gzip.decompress(body)
            return body

    def request(self, **params) -> dict:
        params = {"format": "json", "formatversion": "2", **params}
        delay = 2.0
        last_error: Exception | None = None

        for attempt in range(self.max_retries):
            self._throttle()
            try:
                body = self._raw_request(params)
                self.request_count += 1
            except urllib.error.HTTPError as exc:
                last_error = exc
                if exc.code in (429, 500, 502, 503, 504):
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise WikiError(f"HTTP {exc.code} from {self.api_url}: {exc}") from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                last_error = exc
                time.sleep(delay)
                delay *= 2
                continue

            head = body.lstrip()[:1]
            if head not in (b"{", b"["):
                # Almost always the Cloudflare "Just a moment..." page.
                raise BlockedError(
                    f"{self.api_url} returned non-JSON ({len(body)} bytes). "
                    "Looks like bot protection; retrying is pointless."
                )

            data = json.loads(body.decode("utf-8"))
            if "error" in data:
                raise WikiError(f"API error: {data['error']}")
            return data

        raise WikiError(f"No response from {self.api_url}: {last_error}")

    # ----------------------------------------------------------------- query

    def query(self, **params) -> list[dict]:
        """``action=query`` merging every page of the response via continue."""
        params = {"action": "query", **params}
        results: list[dict] = []
        cont: dict = {}

        while True:
            data = self.request(**{**params, **cont})
            payload = data.get("query")
            if payload:
                results.append(payload)
            if "continue" not in data:
                return results
            cont = data["continue"]

    def _batched(self, titles) -> list[list[str]]:
        titles = list(titles)
        return [
            titles[i : i + TITLES_PER_REQUEST]
            for i in range(0, len(titles), TITLES_PER_REQUEST)
        ]

    def _resolve(self, batch, chunks) -> dict[str, tuple[dict, str | None]]:
        """{requested title: (page, redirect target or None)} for one batch.

        The key is the title the caller asked for, not the page that answered:
        without ``redirects=1`` the wiki returned ``#REDIRECT [[Arts Burst]]``
        as the content of ``Cryo Burst`` and it was stored as such (audit B33). A
        redirect is now reported through the second element, so the caller
        decides what to do with an alias. A bare normalisation (underscores,
        a lower-case first letter) is not a redirect.
        """
        pages = {
            page["title"]: page
            for chunk in chunks
            for page in chunk.get("pages", [])
            if not page.get("missing") and page.get("revisions")
        }
        normalized: dict[str, str] = {}
        redirects: dict[str, str] = {}
        for chunk in chunks:
            for item in chunk.get("normalized", []):
                normalized[item["from"]] = item["to"]
            for item in chunk.get("redirects", []):
                redirects[item["from"]] = item["to"]

        resolved: dict[str, tuple[dict, str | None]] = {}
        for title in batch:
            current = normalized.get(title, title)
            target = current
            # Chains are followed to the end, with a guard against loops.
            seen = {target}
            while target in redirects and redirects[target] not in seen:
                target = redirects[target]
                seen.add(target)
            page = pages.get(target)
            if page is not None:
                resolved[title] = (page, target if target != current else None)
        return resolved

    def revision_meta(self, titles) -> dict[str, dict]:
        """{title: {revid, timestamp[, redirect_to]}} — cheap, no content.

        Keyed by the requested title. For a redirect, ``revid`` and
        ``timestamp`` are the target's and ``redirect_to`` names it. Missing
        pages simply do not appear in the result.
        """
        meta: dict[str, dict] = {}
        for batch in self._batched(titles):
            chunks = self.query(
                prop="revisions",
                rvprop="ids|timestamp",
                redirects=1,
                titles="|".join(batch),
            )
            for title, (page, redirected) in self._resolve(batch, chunks).items():
                revision = page["revisions"][0]
                meta[title] = {
                    "revid": revision["revid"],
                    "timestamp": revision["timestamp"],
                    **({"redirect_to": redirected} if redirected else {}),
                }
        return meta

    def first_revision(self, title: str) -> str | None:
        """Page creation time.

        Needed as an approximate date the content appeared in the game:
        mechanic and talent pages have no version field of their own, and a page
        is created once the mechanic has been seen. It is a lower bound and must
        not be called the exact patch date — but it is checkable, not invented.

        Cannot be batched: ``rvlimit`` works only for a single title.
        """
        for chunk in self.query(
            prop="revisions",
            rvprop="timestamp",
            rvdir="newer",
            rvlimit=1,
            titles=title,
        ):
            for page in chunk.get("pages", []):
                revisions = page.get("revisions") or []
                if revisions:
                    return revisions[0]["timestamp"]
        return None

    def page_content(self, titles) -> dict[str, dict]:
        """{title: {revid, timestamp, content[, redirect_to]}} — raw wikitext.

        Keyed by the requested title; a redirect carries the target's content
        and ``redirect_to`` (see ``revision_meta``).
        """
        pages: dict[str, dict] = {}
        for batch in self._batched(titles):
            chunks = self.query(
                prop="revisions",
                rvprop="ids|timestamp|content",
                rvslots="main",
                redirects=1,
                titles="|".join(batch),
            )
            for title, (page, redirected) in self._resolve(batch, chunks).items():
                revision = page["revisions"][0]
                pages[title] = {
                    "revid": revision["revid"],
                    "timestamp": revision["timestamp"],
                    "content": revision["slots"]["main"]["content"],
                    **({"redirect_to": redirected} if redirected else {}),
                }
        return pages

    def parse_html(self, title: str) -> dict:
        """A rendered page: needed where the wikitext is not self-contained
        (transclusions and query templates in ZZZ)."""
        data = self.request(
            action="parse", page=title, prop="text|revid", disablelimitreport=1
        )
        parsed = data["parse"]
        return {"revid": parsed.get("revid"), "html": parsed["text"]}

    def allpages(self, namespace: int) -> list[str]:
        titles: list[str] = []
        for chunk in self.query(
            list="allpages", apnamespace=namespace, aplimit="max"
        ):
            titles.extend(page["title"] for page in chunk.get("allpages", []))
        return titles

    def category_members(self, category: str) -> list[str]:
        if not category.lower().startswith("category:"):
            category = f"Category:{category}"
        titles: list[str] = []
        for chunk in self.query(
            list="categorymembers", cmtitle=category, cmlimit="max"
        ):
            titles.extend(page["title"] for page in chunk.get("categorymembers", []))
        return titles

    # ----------------------------------------------------------------- cargo

    def cargo_query(self, tables: str, fields: str, **params) -> list[dict]:
        """A Cargo query with automatic pagination via offset."""
        rows: list[dict] = []
        offset = 0

        while True:
            data = self.request(
                action="cargoquery",
                tables=tables,
                fields=fields,
                limit=CARGO_PAGE_SIZE,
                offset=offset,
                **params,
            )
            page = [row["title"] for row in data.get("cargoquery", [])]
            rows.extend(page)
            if len(page) < CARGO_PAGE_SIZE:
                return rows
            offset += CARGO_PAGE_SIZE

    def has_cargo(self) -> bool:
        data = self.request(action="paraminfo", modules="cargoquery")
        return bool(data.get("paraminfo", {}).get("modules"))

    # ---------------------------------------------------------------- files

    def image_info(self, titles) -> dict[str, dict]:
        """{File:Title: {url, sha1, size, width, height, mime}}.

        ``sha1`` stands in for revid here: files have no edit history in the
        same sense, and a content hash is an exact "re-download or not" signal.
        """
        info: dict[str, dict] = {}
        for batch in self._batched(titles):
            for chunk in self.query(
                prop="imageinfo",
                iiprop="url|sha1|size|mime",
                titles="|".join(batch),
            ):
                for page in chunk.get("pages", []):
                    if page.get("missing") or not page.get("imageinfo"):
                        continue
                    item = page["imageinfo"][0]
                    info[page["title"]] = {
                        "url": item["url"],
                        "sha1": item.get("sha1"),
                        "size": item.get("size"),
                        "width": item.get("width"),
                        "height": item.get("height"),
                        "mime": item.get("mime"),
                    }
        return info

    def download(self, url: str) -> bytes:
        """Downloads a file by direct URL, with the same rate limit and User-Agent."""
        delay = 2.0
        last_error: Exception | None = None

        for _ in range(self.max_retries):
            self._throttle()
            try:
                request = urllib.request.Request(url)
                request.add_header("User-Agent", self.user_agent)
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    body = response.read()
                self.request_count += 1
                return body
            except urllib.error.HTTPError as exc:
                last_error = exc
                if exc.code in (429, 500, 502, 503, 504):
                    time.sleep(delay)
                    delay *= 2
                    continue
                raise WikiError(f"HTTP {exc.code} while downloading {url}") from exc
            except (urllib.error.URLError, TimeoutError) as exc:
                last_error = exc
                time.sleep(delay)
                delay *= 2

        raise WikiError(f"Could not download {url}: {last_error}")
