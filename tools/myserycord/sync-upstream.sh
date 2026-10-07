#!/bin/sh
# Myserycord: merge the official Fluxer main into the current branch.
#  - upstream CI (.github/workflows/*, CODEOWNERS, labeller) stays deleted: only our
#    .github/workflows/desktop.yml runs on the GitHub mirror.
#  - .po catalogues: take upstream's, then rebrand_po.py renames Fluxer again.
#  - any other conflict stops the merge (exit 1): fix it by hand, nothing is pushed.
# Prints the upstream commit the result contains on the last line.
set -eu
UPSTREAM=${UPSTREAM:-https://github.com/fluxerapp/fluxer.git}
git fetch --quiet "$UPSTREAM" main
up=$(git rev-parse FETCH_HEAD)

if ! git merge-base --is-ancestor "$up" HEAD; then
	if ! git merge --quiet --no-edit -m "chore: merge upstream Fluxer ${up%"${up#?????????}"}" "$up"; then
		for f in $(git diff --name-only --diff-filter=U); do
			case "$f" in
				.github/workflows/desktop.yml) echo "conflict: $f" >&2; git merge --abort; exit 1 ;;
				.github/workflows/*|.github/CODEOWNERS|.github/labeller.yaml) git rm --quiet -- "$f" ;;
				fluxer_app/src/features/i18n/locales/*/messages.po) git checkout --theirs -- "$f" && git add -- "$f" ;;
				*) echo "conflict: $f" >&2; git merge --abort; exit 1 ;;
			esac
		done
		git commit --quiet --no-edit
	fi
fi

# Workflows upstream adds would run on the GitHub mirror.
for f in $(git ls-files .github/workflows .github/CODEOWNERS .github/labeller.yaml); do
	[ "$f" = .github/workflows/desktop.yml ] || git rm --quiet -- "$f"
done
python3 "$(dirname "$0")/rebrand_po.py" .
git add -A .github fluxer_app/src/features/i18n/locales
git diff --cached --quiet || git commit --quiet -m "chore: rebrand strings from upstream"
echo "$up"
