# Security Policy

## Reporting a vulnerability

Email **u.fourier123@gmail.com**, or open a private report via
[GitHub Security Advisories](https://github.com/jacobwright32/uk-grid-atlas/security/advisories/new).
Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a few days. This is a small project maintained
in spare time, so a fix may take longer than that, but you will hear where it
stands.

## Scope

Both parts of this repository are in scope: the atlas web app and the
`world-energy-generation` Python package.

Things worth reporting:

- Anything in the Python package that could execute code, write outside its cache
  directory, or be induced to fetch from an unintended host by a crafted response
  or base URL.
- Cross-site scripting or injection in the atlas, including through data the
  pipeline ingests from upstream APIs or OpenStreetMap.
- A leaked credential in the repository, its history, or a published artifact —
  the workflows read ENTSO-E and Elexon tokens from Actions secrets and none
  should ever appear in a file, a build output, or a log.
- Anything in a GitHub Actions workflow that would let a fork or a pull request
  obtain repository secrets or publish to PyPI.

Out of scope: the accuracy of the data itself. A wrong number is a bug worth
reporting, but it belongs in a normal issue — please use the "A number looks
wrong" template.

## A note on the data path

The package fetches static JSON over HTTPS from GitHub Pages and parses it with
the standard library `json` module. It executes nothing from the response, and
never sends credentials, because there are none to send — every endpoint it reads
is public and unauthenticated.

The base URL is overridable, by constructor argument or the
`WORLD_ENERGY_BASE_URL` environment variable, which is deliberate so that a fork
or a mirror can be used without waiting for a release. Treat it the way you would
any URL your code fetches from: pointing it at a host you do not trust means
trusting that host's JSON.

## Supported versions

Fixes go into the latest release. Given the project's size, older versions are
not patched — upgrading is the supported path.
