# AUR updater

> An utility to assist in keeping AUR packages up to date.

Checks GitHub for new releases and changes the sha sums and package version in your AUR package automatically.
Then pushes the changes to the AUR through git.

# Caveats

The PKGBUILD file has to have nearly exactly the format as for example [vscodium-bin](https://aur.archlinux.org/packages/vscodium-bin)

Caveats (for now) includes (but is probably not limited to)

-   Separate fields for sums for each architecture
-   There can only be one arch-speciffic source; we cannot parse more than one sum per architecture
-   GitHub has to have assets for each source with a sum for said source, defined in `config.sum_filter_regex`
    > This should be addressed and resolved soon
-   Supported architectures are for now only x86_32, x86_64, aarch64, and armv7h

# Issues

Also see `Caveats` above.

-   [ ] Does not work with sha256 and sha512 in same PKGBUILD
-   [ ] Cannot work with collection of sums, they have to have an explicit arch
-   [ ] Sums have to be available in the release assets
-   [ ] [Support for additional architectures](https://aur.archlinux.org/cgit/aur.git/tree/PKGBUILD?h=paru)
-   [ ] Config options for git commands
-   [ ] Sums have a regex filter in the config. Can this be replaced by reading the PKGBUILD for info about assets and searching for related assets from GitHub
-   [ ] Authentication to increase the GitHub rate limit
