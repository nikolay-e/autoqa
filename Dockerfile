# Portable autoqa image — runs the full pipeline in any CI or via `docker run`.
# Base tag MUST match the `playwright` version in tools/crawler/package-lock.json
# (browser binaries are pinned per release); bump both together.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       python3 python3-venv jq curl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Schemathesis in an isolated venv (PEP-668 safe on jammy and a future noble bump).
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip schemathesis
ENV PATH="/opt/venv/bin:${PATH}"

WORKDIR /opt/autoqa

# Node deps first for layer caching. Browsers are already in the base image
# (matching tag), so no `playwright install` is needed.
COPY tools/crawler/package.json tools/crawler/package-lock.json tools/crawler/
RUN cd tools/crawler && npm ci

COPY . .

ENV QA_OUTPUT_DIR=/tmp/qa-reports
ENTRYPOINT ["bash", "/opt/autoqa/scripts/run-all.sh"]
