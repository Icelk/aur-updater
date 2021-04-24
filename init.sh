#!/bin/bash

package=$1

if [[ -z "$package" ]]; then
    echo "Please specify a package to clone."
    exit 1
fi

git clone https://aur.archlinux.org/$package.git remote
