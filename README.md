# AUR updater

> An utility to assist in keeping AUR packages up to date.

Checks GitHub for new releases and changes the sha sums and package version in your AUR package automatically.
Then pushes the changes to the AUR through git.

# Issues

-   [ ] Does not work with sha256 and sha512 in same PKGBUILD
-   [ ] Cannot work with collection of sums, they have to have an explicit arch
-   [ ] Sums have to be available in the release assets
-   [ ] [Support for additional architectures](https://aur.archlinux.org/cgit/aur.git/tree/PKGBUILD?h=paru)
-   [ ] Config options for git commands
