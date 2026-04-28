from __future__ import annotations

import io
import json
import re
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import uuid4
from urllib.parse import quote_plus, urlparse

import httpx
from bs4 import BeautifulSoup
from fastapi import HTTPException
from pypdf import PdfReader

from .config import LITERATURE_CACHE_DIR


def slugify_filename(value: str, fallback: str = "literature-source") -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip().lower()).strip("-._")
    return slug[:80] or fallback


def is_url(value: str) -> bool:
    return bool(re.match(r"^https?://", value.strip(), flags=re.IGNORECASE))


def abstract_from_inverted_index(index: dict[str, list[int]] | None) -> str:
    if not index:
        return ""
    words: list[tuple[int, str]] = []
    for word, positions in index.items():
        for position in positions:
            words.append((position, word))
    words.sort(key=lambda item: item[0])
    return " ".join(word for _, word in words)


def plain_text_from_html(html: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" ", strip=True)).strip()


def extract_pdf_text(content: bytes) -> str:
    reader = PdfReader(io.BytesIO(content))
    text = "\n\n".join(page.extract_text() or "" for page in reader.pages)
    return text.strip()


def make_http_client() -> httpx.Client:
    return httpx.Client(
        timeout=30,
        follow_redirects=True,
        headers={
            "User-Agent": "ThesisAIStudio/0.1 literature-research",
        },
    )


def normalize_openalex_result(item: dict[str, Any]) -> dict[str, Any]:
    primary_location = item.get("primary_location") or {}
    authorships = item.get("authorships") or []
    authors = []
    for authorship in authorships[:8]:
        author = authorship.get("author") or {}
        name = str(author.get("display_name", "")).strip()
        if name:
            authors.append(name)
    candidate = {
        "title": str(item.get("title", "")).strip(),
        "authors": authors,
        "year": item.get("publication_year"),
        "venue": (((primary_location.get("source") or {}).get("display_name")) or "").strip(),
        "abstract": abstract_from_inverted_index(item.get("abstract_inverted_index")),
        "source_url": primary_location.get("landing_page_url") or item.get("doi") or item.get("id") or "",
        "download_url": primary_location.get("pdf_url") or "",
        "doi": item.get("doi") or "",
        "openalex_id": item.get("id") or "",
    }
    return normalize_candidate_links(candidate)


def normalize_candidate_links(candidate: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(candidate or {})
    source_url = str(normalized.get("source_url", "") or "").strip()
    doi = str(normalized.get("doi", "") or "").strip()
    openalex_id = str(normalized.get("openalex_id", "") or "").strip()
    if not source_url:
        source_url = doi or openalex_id
    normalized["source_url"] = source_url
    normalized["download_url"] = str(normalized.get("download_url", "") or "").strip()
    return normalized


def search_openalex(query: str, limit: int = 5) -> list[dict[str, Any]]:
    with make_http_client() as client:
        response = client.get(
            "https://api.openalex.org/works",
            params={"search": query, "per-page": limit},
        )
        response.raise_for_status()
        payload = response.json()
    return [normalize_openalex_result(item) for item in payload.get("results", [])]


def lookup_openalex_by_doi(doi_or_url: str) -> dict[str, Any] | None:
    doi = doi_or_url.strip()
    doi = doi.removeprefix("https://doi.org/").removeprefix("http://doi.org/")
    doi = doi.removeprefix("doi:")
    if "/" not in doi:
        return None
    encoded = httpx.URL(f"https://api.openalex.org/works/https://doi.org/{doi}")
    with make_http_client() as client:
        response = client.get(str(encoded))
    if response.status_code >= 400:
        return None
    return normalize_openalex_result(response.json())


def fetch_url_candidate(url: str) -> dict[str, Any]:
    with make_http_client() as client:
        response = client.get(url)
        response.raise_for_status()
    content_type = response.headers.get("content-type", "").lower()
    title = ""
    abstract = ""
    download_url = ""
    excerpt = ""
    if "pdf" in content_type or url.lower().endswith(".pdf"):
        excerpt = extract_pdf_text(response.content)[:6000]
        title = Path(urlparse(str(response.url)).path).name or "PDF source"
        download_url = str(response.url)
    else:
        html = response.text
        soup = BeautifulSoup(html, "html.parser")
        title = (soup.title.string or "").strip() if soup.title and soup.title.string else ""
        for selector in [
            {"name": "citation_title"},
            {"property": "og:title"},
            {"name": "twitter:title"},
        ]:
            meta = soup.find("meta", attrs=selector)
            if meta and meta.get("content"):
                title = meta["content"].strip()
                break
        for selector in [
            {"name": "citation_abstract"},
            {"name": "description"},
            {"property": "og:description"},
        ]:
            meta = soup.find("meta", attrs=selector)
            if meta and meta.get("content"):
                abstract = meta["content"].strip()
                break
        pdf_meta = soup.find("meta", attrs={"name": "citation_pdf_url"})
        if pdf_meta and pdf_meta.get("content"):
            download_url = pdf_meta["content"].strip()
        excerpt = plain_text_from_html(html)[:6000]
    return normalize_candidate_links({
        "title": title or url,
        "authors": [],
        "year": "",
        "venue": urlparse(str(response.url)).netloc,
        "abstract": abstract,
        "source_url": str(response.url),
        "download_url": download_url,
        "doi": "",
        "openalex_id": "",
        "excerpt": excerpt,
    })


def build_google_scholar_search_url(query: str) -> str:
    return f"https://scholar.google.com/scholar?q={quote_plus(query.strip())}"


def dedupe_candidates(candidates: list[dict[str, Any]], limit: int = 5) -> list[dict[str, Any]]:
    unique: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in candidates:
        normalized = normalize_candidate_links(item)
        key = (
            str(normalized.get("source_url", "")).strip()
            or str(normalized.get("doi", "")).strip()
            or str(normalized.get("openalex_id", "")).strip()
            or str(normalized.get("title", "")).strip().lower()
        )
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(normalized)
        if len(unique) >= limit:
            break
    return unique


def search_literature_candidates(query: str, limit: int = 5) -> dict[str, Any]:
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="请输入论文标题、DOI 或链接。")

    scholar_url = build_google_scholar_search_url(query)
    query_kind = "query"

    if is_url(query):
        query_kind = "url"
        doi_match = re.search(r"(10\.\d{4,9}/[-._;()/:A-Z0-9]+)", query, flags=re.IGNORECASE)
        if doi_match:
            query_kind = "doi"
            openalex_hit = lookup_openalex_by_doi(doi_match.group(1))
            if openalex_hit:
                return {
                    "candidate": openalex_hit,
                    "search_results": [openalex_hit],
                    "scholar_search_url": scholar_url,
                    "query_kind": query_kind,
                }

        fetched = fetch_url_candidate(query)
        if fetched.get("title"):
            results = dedupe_candidates([fetched, *search_openalex(fetched["title"], limit=limit)], limit=limit)
            return {
                "candidate": results[0] if results else fetched,
                "search_results": results or [fetched],
                "scholar_search_url": scholar_url,
                "query_kind": query_kind,
            }
        return {
            "candidate": fetched,
            "search_results": [fetched],
            "scholar_search_url": scholar_url,
            "query_kind": query_kind,
        }

    results = dedupe_candidates(search_openalex(query, limit=max(limit, 5)), limit=limit)
    if results:
        return {
            "candidate": results[0],
            "search_results": results,
            "scholar_search_url": scholar_url,
            "query_kind": query_kind,
        }

    fallback = normalize_candidate_links(
        {
            "title": query,
            "authors": [],
            "year": "",
            "venue": "Google Scholar search",
            "abstract": "",
            "source_url": scholar_url,
            "download_url": "",
            "doi": "",
            "openalex_id": "",
            "excerpt": "",
        }
    )
    return {
        "candidate": fallback,
        "search_results": [],
        "scholar_search_url": scholar_url,
        "query_kind": query_kind,
    }


def resolve_literature_candidate(query: str) -> dict[str, Any]:
    return search_literature_candidates(query, limit=5)["candidate"]


def build_literature_prompt(
    query: str,
    candidate: dict[str, Any],
    outline: list[dict[str, Any]],
    imported_source_excerpts: list[dict[str, str]] | None = None,
    source_focus: dict[str, Any] | None = None,
    query_kind: str = "query",
) -> str:
    payload = {
        "user_query": query,
        "query_kind": query_kind,
        "candidate_source": candidate,
        "paper_outline": outline,
    }
    if imported_source_excerpts:
        payload["imported_source_excerpts"] = imported_source_excerpts
    if source_focus:
        payload["source_focus"] = source_focus
    return json.dumps(payload, ensure_ascii=False, indent=2)


def cache_literature_result(payload: dict[str, Any]) -> str:
    cache_id = f"lit-{uuid4().hex}"
    LITERATURE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache_path = LITERATURE_CACHE_DIR / f"{cache_id}.json"
    cache_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    return cache_id


def load_cached_literature(cache_id: str) -> dict[str, Any]:
    cache_path = LITERATURE_CACHE_DIR / f"{cache_id}.json"
    if not cache_path.exists():
        raise HTTPException(status_code=404, detail="没有找到这条文献分析缓存，请重新分析。")
    return json.loads(cache_path.read_text(encoding="utf-8"))


def source_note_text(candidate: dict[str, Any], analysis: dict[str, Any]) -> str:
    lines = [
        f"Title: {candidate.get('title', '')}",
        f"Authors: {', '.join(candidate.get('authors', []))}",
        f"Year: {candidate.get('year', '')}",
        f"Venue: {candidate.get('venue', '')}",
        f"Source URL: {candidate.get('source_url', '')}",
        f"Download URL: {candidate.get('download_url', '')}",
        "",
        "Summary:",
        analysis.get("summary", ""),
        "",
        "Relevance:",
        analysis.get("relevance", ""),
        "",
        "Structure Suggestions:",
    ]
    lines.extend(f"- {item}" for item in analysis.get("structure_suggestions", []))
    lines.extend(["", "Citation Uses:"])
    lines.extend(f"- {item}" for item in analysis.get("citation_uses", []))
    review = analysis.get("literature_review", "")
    if review:
        lines.extend(["", "Literature Review Draft:", review])
    discussion_points = analysis.get("discussion_points", [])
    if discussion_points:
        lines.extend(["", "Discussion Points:"])
        lines.extend(f"- {item}" for item in discussion_points)
    lines.extend(["", "Import Recommendation:", analysis.get("import_recommendation", "")])
    abstract = candidate.get("abstract", "")
    if abstract:
        lines.extend(["", "Abstract:", abstract])
    excerpt = candidate.get("excerpt", "")
    if excerpt:
        lines.extend(["", "Excerpt:", excerpt])
    return "\n".join(lines).strip() + "\n"


def yaml_escape(value: str) -> str:
    return str(value or "").replace("\\", "\\\\").replace('"', '\\"')


def build_literature_review_qmd(candidate: dict[str, Any], analysis: dict[str, Any]) -> str:
    source_title = str(analysis.get("title") or candidate.get("title") or "Literature Review Draft").strip()
    title = f"Literature Review - {source_title}"
    authors = ", ".join(candidate.get("authors", []) or analysis.get("authors", []))
    venue = str(candidate.get("venue") or analysis.get("venue") or "").strip()
    year = str(candidate.get("year") or analysis.get("year") or "").strip()
    lines = [
        "---",
        f'title: "{yaml_escape(title)}"',
        "format:",
        "  html:",
        "    toc: true",
        "---",
        "",
        "## Source",
        "",
        f"- Title: {source_title}",
    ]
    if authors:
        lines.append(f"- Authors: {authors}")
    if year:
        lines.append(f"- Year: {year}")
    if venue:
        lines.append(f"- Venue: {venue}")
    if candidate.get("source_url"):
        lines.append(f"- Source URL: {candidate.get('source_url')}")
    if candidate.get("download_url"):
        lines.append(f"- Download URL: {candidate.get('download_url')}")
    if analysis.get("summary"):
        lines.extend(["", "## Summary", "", str(analysis.get("summary")).strip()])
    if analysis.get("relevance"):
        lines.extend(["", "## Relevance", "", str(analysis.get("relevance")).strip()])
    if analysis.get("literature_review"):
        lines.extend(["", "## Literature Review Draft", "", str(analysis.get("literature_review")).strip()])
    if analysis.get("structure_suggestions"):
        lines.extend(["", "## Structure Suggestions", ""])
        lines.extend([f"- {item}" for item in analysis.get("structure_suggestions", [])])
    if analysis.get("citation_uses"):
        lines.extend(["", "## Citation Uses", ""])
        lines.extend([f"- {item}" for item in analysis.get("citation_uses", [])])
    if analysis.get("discussion_points"):
        lines.extend(["", "## Discussion Points", ""])
        lines.extend([f"- {item}" for item in analysis.get("discussion_points", [])])
    if analysis.get("import_recommendation"):
        lines.extend(["", "## Import Recommendation", "", str(analysis.get("import_recommendation")).strip()])
    return "\n".join(lines).strip() + "\n"


def save_literature_review_output(project: Path, candidate: dict[str, Any], analysis: dict[str, Any]) -> str:
    review_text = str(analysis.get("literature_review", "")).strip()
    if not review_text:
        return ""
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = slugify_filename(candidate.get("title") or analysis.get("title") or "literature-review", fallback="literature-review")
    relative_path = f"outputs/literature-review-{stem}-{timestamp}.qmd"
    output_path = project / relative_path
    counter = 2
    while output_path.exists():
        relative_path = f"outputs/literature-review-{stem}-{timestamp}-{counter}.qmd"
        output_path = project / relative_path
        counter += 1
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(build_literature_review_qmd(candidate, analysis), encoding="utf-8")
    return relative_path


def import_literature_source(cache_id: str, project: Path, download_original: bool) -> dict[str, Any]:
    cached = load_cached_literature(cache_id)
    candidate = cached.get("candidate") or {}
    analysis = cached.get("analysis") or {}
    title = candidate.get("title") or "literature-source"
    stem = slugify_filename(title, fallback="literature-source")
    sources_dir = project / "sources"
    sources_dir.mkdir(parents=True, exist_ok=True)
    text_content = source_note_text(candidate, analysis)
    stored_filename = f"{stem}.txt"
    saved_original = None

    if download_original and candidate.get("download_url"):
        with make_http_client() as client:
            response = client.get(candidate["download_url"])
            response.raise_for_status()
        content_type = response.headers.get("content-type", "").lower()
        if "pdf" in content_type or str(candidate["download_url"]).lower().endswith(".pdf"):
            stored_filename = f"{stem}.pdf"
            (sources_dir / stored_filename).write_bytes(response.content)
            extracted = extract_pdf_text(response.content)
            text_content = source_note_text(candidate, analysis) + "\n" + extracted
            saved_original = stored_filename
        else:
            stored_filename = f"{stem}.html"
            (sources_dir / stored_filename).write_text(response.text, encoding="utf-8")
            text_content = source_note_text(candidate, analysis) + "\n" + plain_text_from_html(response.text)
            saved_original = stored_filename

    text_file = f"{stem}.txt"
    (sources_dir / text_file).write_text(text_content, encoding="utf-8")
    return {
        "filename": saved_original or text_file,
        "text_file": text_file,
        "characters": len(text_content),
        "imported_at": datetime.now().isoformat(timespec="seconds"),
        "source_url": candidate.get("source_url", ""),
        "downloaded_original": bool(saved_original),
    }
