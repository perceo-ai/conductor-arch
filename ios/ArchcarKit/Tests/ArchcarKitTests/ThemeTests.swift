import Testing

@testable import ArchcarKit

@Test func parsesHexColors() throws {
    #expect(ColorComponents(css: "#000") == ColorComponents(red: 0, green: 0, blue: 0, alpha: 1))
    #expect(ColorComponents(css: "#ffffff")?.red == 1)
    #expect(ColorComponents(css: "#00000080")?.alpha == 128.0 / 255.0)
}

@Test func parsesRgbFunctions() {
    #expect(ColorComponents(css: "rgb(255, 0, 0)") == ColorComponents(red: 1, green: 0, blue: 0, alpha: 1))
    #expect(ColorComponents(css: "rgba(0, 0, 255, 0.5)")?.alpha == 0.5)
    #expect(ColorComponents(css: "rgb(14, 14, 14)")?.green == 14.0 / 255.0)
}

@Test func parsesColorSrgbFunction() throws {
    // What the generator emits for tokens the browser resolves out of
    // color-mix(): components are already 0-1, not 0-255.
    let color = try #require(ColorComponents(css: "color(srgb 0.831373 0.662745 0.309804 / 0.14)"))
    #expect(abs(color.red - 0.831373) < 0.0001)
    #expect(abs(color.alpha - 0.14) < 0.0001)
    let opaque = try #require(ColorComponents(css: "color(srgb 0 0.5 1)"))
    #expect(opaque.alpha == 1)
}

@Test func rejectsUnparseableValues() {
    #expect(ColorComponents(css: "12px") == nil)
    #expect(ColorComponents(css: "inset 0 1px 0 rgba(255, 255, 255, .9)") == nil)
}

@Test func themeCarriesBothTonesWithMatchingKeys() {
    #expect(Theme.dark.tokens.count > 100)
    #expect(Set(Theme.dark.tokens.keys) == Set(Theme.light.tokens.keys))
}

@Test func nonColourTokensKeepTheirDeclaredValues() throws {
    // Probing every token as a colour used to record the *inherited* colour for
    // durations, radii, and font stacks, because an invalid `color` declaration
    // inherits rather than keeping its previous value.
    #expect(Theme.dark.raw("--ui-radius")?.hasSuffix("px") == true)
    #expect(Theme.dark.raw("--mo-base")?.hasSuffix("s") == true)
    #expect(Theme.dark.raw("--ui-font-sans")?.contains("sans-serif") == true)
    // And they are not colours, so asking for one returns nothing.
    #expect(Theme.dark.color("--ui-radius") == nil)
    #expect(Theme.dark.color("--ui-font-sans") == nil)

    // Colours still resolve, including ones written as color-mix().
    #expect(Theme.dark.color("--el-0") != nil)
    #expect(Theme.dark.color("--accent-wash") != nil)
}

@Test func themeTokensDifferBetweenTones() throws {
    // If these matched, the generator read the same tone twice and the light
    // theme would silently ship as dark.
    #expect(Theme.dark.raw("--el-0") != Theme.light.raw("--el-0"))
    let darkBackground = try #require(Theme.dark.color("--el-0"))
    let lightBackground = try #require(Theme.light.color("--el-0"))
    #expect(darkBackground.red < 0.2)
    #expect(lightBackground.red > 0.8)
}
