import Foundation

extension ColorComponents {
    /// Parses the colour forms the generator emits: `#rgb`, `#rrggbb`,
    /// `#rrggbbaa`, `rgb()`/`rgba()`, and `color(srgb r g b / a)` — the last
    /// being what the browser resolves a `color-mix()` token to.
    ///
    /// Anything else returns nil, because most tokens in the bundle are not
    /// colours at all: shadows, lengths, and easing curves live there too.
    public init?(css value: String) {
        let text = value.trimmingCharacters(in: .whitespaces).lowercased()

        if text.hasPrefix("#") {
            let hex = String(text.dropFirst())
            switch hex.count {
            case 3, 4:
                self.init(css: "#" + hex.map { "\($0)\($0)" }.joined())
                return
            case 6, 8:
                let chars = Array(hex)
                func component(_ range: ClosedRange<Int>) -> Double? {
                    UInt8(String(chars[range]), radix: 16).map { Double($0) / 255.0 }
                }
                guard let red = component(0...1), let green = component(2...3),
                      let blue = component(4...5) else { return nil }
                self.init(
                    red: red, green: green, blue: blue,
                    alpha: hex.count == 8 ? (component(6...7) ?? 1) : 1)
                return
            default:
                return nil
            }
        }

        if text.hasPrefix("color(") {
            guard let open = text.firstIndex(of: "("), let close = text.lastIndex(of: ")") else {
                return nil
            }
            var body = text[text.index(after: open)..<close]
                .trimmingCharacters(in: .whitespaces)
            guard body.hasPrefix("srgb") else { return nil }
            body = String(body.dropFirst("srgb".count))
            let numbers = Self.numbers(in: body)
            guard numbers.count == 3 || numbers.count == 4 else { return nil }
            // Already 0-1 in this form, unlike rgb().
            self.init(
                red: numbers[0], green: numbers[1], blue: numbers[2],
                alpha: numbers.count == 4 ? numbers[3] : 1)
            return
        }

        guard text.hasPrefix("rgb"), let open = text.firstIndex(of: "("),
              let close = text.lastIndex(of: ")") else { return nil }
        let numbers = Self.numbers(in: String(text[text.index(after: open)..<close]))
        guard numbers.count == 3 || numbers.count == 4 else { return nil }
        self.init(
            red: numbers[0] / 255.0, green: numbers[1] / 255.0, blue: numbers[2] / 255.0,
            alpha: numbers.count == 4 ? numbers[3] : 1)
    }

    private static func numbers(in text: some StringProtocol) -> [Double] {
        text.split(whereSeparator: { $0 == "," || $0 == " " || $0 == "/" })
            .compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
    }
}
