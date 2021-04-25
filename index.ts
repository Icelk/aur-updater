import fs = require("fs")
import fetch = require("node-fetch")
import { execFile } from "child-process-promise"

const packageGitPath = "remote"
const pkgBuildVerRegex = /pkgver=.*/

const request: (
    method: "GET" | "POST" | "PUT",
    url: string,
    download?: boolean
) => Promise<fetch.Response> = async (method, url, download = false) => {
    const uri = url.startsWith("http") ? url : `https://api.github.com${url}`
    return await fetch.default(uri, {
        method,
        headers: {
            accept: download
                ? "application/octet-stream"
                : "application/vnd.github.v3+json",
            agent: "AUR updates",
        },
    })
}

enum Arch {
    x86_64,
    i686,
    aarch64,
    armv7h,
}
function firstArchSubstring(text: string): Arch | null {
    const associations = [
        [Arch.x86_64, "x64"],
        [Arch.x86_64, "x86_64"],
        [Arch.x86_64, "x86-64"],
        [Arch.i686, "i386"],
        [Arch.i686, "i486"],
        [Arch.i686, "i586"],
        [Arch.i686, "i686"],
        [Arch.i686, "x86-32"],
        [Arch.i686, "x86_32"],
        [Arch.i686, "ia32"],

        [Arch.aarch64, "aarch64"],
        [Arch.aarch64, "arm64"],
        [Arch.armv7h, "armv7h"],
        [Arch.armv7h, "armhf"],
        [Arch.i686, "x86"],
    ]
    for (let i = 0; i < associations.length; i++) {
        const association = associations[i]
        if (text.indexOf(association[1] as string) >= 0) {
            return association[0] as Arch
        }
    }
    return null
}
function findPkgVer(file: string): string | null {
    const matches = file.match(pkgBuildVerRegex)
    if (matches === null) {
        return null
    } else {
        return matches[0]
    }
}

async function run() {
    const config = JSON.parse(
        (await fs.promises.readFile("config.json")).toString()
    )

    const gitPath = packageGitPath

    if (
        config.repo === undefined ||
        config.owner === undefined ||
        config.signature_regex === undefined
    ) {
        console.error(
            "Missing fields from configuration. Requires `repo`, `owner`, and `signature_regex`."
        )
        process.exit(1)
    }

    const pkgBuildPath = config.pkgbuild ?? "PKGBUILD"

    let pkgBuild = (
        await fs.promises.readFile(`${gitPath}/${pkgBuildPath}`)
    ).toString()

    const latestSynced = findPkgVer(pkgBuild)

    const githubData = await (
        await request(
            "GET",
            `/repos/${config.owner}/${config.repo}/releases/latest`
        )
    ).json()
    const remoteTag = githubData.tag_name
    const update = remoteTag !== latestSynced

    if (update) {
        await execFile("git", ["pull"], { cwd: gitPath, encoding: "utf8" })

        pkgBuild = (
            await fs.promises.readFile(`${gitPath}/${pkgBuildPath}`)
        ).toString()

        const verAfterPull = findPkgVer(pkgBuild)
        if (verAfterPull === remoteTag) {
            return
        }
        await updatePackage(
            gitPath,
            githubData,
            config.signature_regex,
            remoteTag,
            pkgBuildPath,
            config.srcinfo ?? ".SRCINFO",
            config.dry_run ?? false
        )
    }
}
async function updatePackage(
    remotePath: string,
    response: any,
    regex: string,
    newTag: string,
    pkgBuildPath: string,
    srcInfoPath: string,
    dryRun: boolean
) {
    const pkgBuild = (
        await fs.promises.readFile(`${packageGitPath}/${pkgBuildPath}`)
    ).toString("utf8")
    // Update PKGBUILD pkgver
    let newPkgBuild = pkgBuild.replace(pkgBuildVerRegex, `pkgver=${newTag}`)

    const signatureRegex = new RegExp(regex)
    const pkgBuildSumRegex = /sha([0-9]+)sums/g
    const assets: { name: string; url: string }[] = response.assets

    const arches: { arch: Arch; sigStart: number; sigEnd: number }[] = []
    const sumMatches = newPkgBuild.matchAll(pkgBuildSumRegex)
    let numSumMatches = 0
    for (const match of sumMatches) {
        if (match.index === undefined || match.length === 0) {
            console.log("no signature fields, skipping")
            break
        }
        const end = match.index + match[0].length

        if (newPkgBuild.substring(end, end + 1) !== "_") {
            console.warn(
                "signature definition without explicit arches are not supported"
            )
            continue
        }

        const s = newPkgBuild.substring(end)
        const eq = s.search(/[=]/)
        const arch = firstArchSubstring(s.substring(0, eq))
        const sigStart = s.search(/["']/) + 1
        const sigEnd = s.substring(sigStart).search(/["']/) + sigStart

        if (arch === null) {
            console.warn("Arch '" + s.substring(0, eq) + "' not recognised.")
            continue
        }

        console.log(
            `Found arch sum '${arch}' with sum ${s.substring(sigStart, sigEnd)}`
        )

        arches.push({
            arch,
            sigStart: sigStart + end,
            sigEnd: sigEnd + end,
        })
        numSumMatches += 1
    }

    if (arches.length !== numSumMatches) {
        console.error(
            "Number of architecture sums and number of matches are not equal"
        )
        process.exit(1)
    }

    if (arches.length > 0) {
        const replaceSum = (start: number, end: number, newSum: string) => {
            console.log(`Replacing sum ${newPkgBuild.substring(start, end)}`)

            newPkgBuild = `${newPkgBuild.substring(
                0,
                start
            )}${newSum}${newPkgBuild.substring(end)}`

            const offset = start - end + newSum.length
            for (let i = 0; i < arches.length; i++) {
                const arch = arches[i]
                if (arch.sigStart > end) {
                    arch.sigStart += offset
                    arch.sigEnd += offset
                }
            }
        }
        const getReplaceSum = async (
            start: number,
            end: number,
            url: string
        ) => {
            const response = await request("GET", url, true)
            const sum = (await response.text()).split(" ")[0]
            console.log("Got sum " + sum)

            replaceSum(start, end, sum)
        }

        for (let assetIndex = 0; assetIndex < assets.length; assetIndex++) {
            const asset = assets[assetIndex]

            const name = asset.name
            if (!signatureRegex.test(name)) {
                continue
            }
            console.log("Applicable asset: " + name)

            const firstArch = firstArchSubstring(name)

            for (let archIndex = 0; archIndex < arches.length; archIndex++) {
                const arch = arches[archIndex]

                if (arch.arch === firstArch) {
                    const url = asset.url

                    getReplaceSum(arch.sigStart, arch.sigEnd, url)
                }
            }
        }
    }

    if (!dryRun) {
        fs.promises.writeFile(`${remotePath}/${pkgBuildPath}`, newPkgBuild)

        // Execute makepkg after writing to PKGBUILD
        const makePkgOutput = await execFile("makepkg", ["--printsrcinfo"], {
            cwd: remotePath,
            encoding: "utf8",
        })
        if (makePkgOutput.childProcess.exitCode !== 0) {
            console.error("makepkg failed!")
            console.error(makePkgOutput.stderr)

            process.exit(1)
        } else {
            await fs.promises.writeFile(
                `${remotePath}/${srcInfoPath}`,
                makePkgOutput.stdout
            )
        }
        const diff = await execFile("git", ["diff"], {
            cwd: "remote",
            encoding: "utf8",
        })
        const hasChanged = diff.stdout.length > 0

        if (hasChanged) {
            await execFile("git", ["add", "."], {
                cwd: "remote",
                encoding: "utf8",
            })
            await execFile(
                "git",
                [
                    "commit",
                    "-m",
                    `Updated to ${newTag}\nThis was an auto-update by https://github.com/Icelk/aur-updater`,
                ],
                { cwd: "remote", encoding: "utf8" }
            )

            const gitPushOutput = await execFile("git", ["push"], {
                cwd: "remote",
                encoding: "utf8",
            }).then(
                (o) => {
                    return o
                },
                (err) => {
                    console.error(
                        "You don't have the permissions to push changes"
                    )
                    console.error(err)
                    return null
                }
            )
            if (gitPushOutput === null) {
                return
            }
            if (gitPushOutput.childProcess.exitCode !== 0) {
                console.error("Failed to `git push`!")
                console.error(gitPushOutput.stderr)
            } else {
                console.log("Pushed changes")
            }
        } else {
            console.error(
                "Nothing changed according to Git, yet we have updated!"
            )
        }
    }
}
run()
