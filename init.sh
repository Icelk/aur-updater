#!/bin/bash

if [[ -z "$1" ]]; then
    echo "Please specify a package to clone."
    exit 1
fi

for package in "$@"; do
    git clone "ssh://aur.archlinux.org/$package.git" "remote-$package"
done
