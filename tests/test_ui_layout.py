from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).parents[1]
HTML = (ROOT / "app/static/index.html").read_text(encoding="utf-8")
CSS = (ROOT / "app/static/style.css").read_text(encoding="utf-8")
JS = (ROOT / "app/static/app.js").read_text(encoding="utf-8")


class PageParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.tabs = []

    def handle_starttag(self, tag, attrs):
        props = dict(attrs)
        if "id" in props:
            self.ids.append(props["id"])
        if tag == "button" and "tab" in props.get("class", "").split():
            self.tabs.append(props.get("data-tab"))


def test_all_views_and_device_controls_remain_accessible():
    page = PageParser()
    page.feed(HTML)
    assert len(page.ids) == len(set(page.ids)), [
        item for item, count in Counter(page.ids).items() if count > 1
    ]
    assert page.tabs == ["dashboard", "messages", "trace", "advanced", "lin"]
    required = (
        "deviceBadge", "openDeviceBtn", "closeDeviceBtn",
        "deviceInfo", "deviceAction", "channelCards", "metrics",
        "messageForm", "messageRows", "nodeActions", "msgData", "msgKind",
        "traceMode", "traceRows", "traceVisibleCount",
        "filterJson", "queueJson", "propPath", "propResult",
        "linChannel", "linSubJson", "linPubJson", "configDialog",
        "canConfigCards", "linConfigCards", "pageName",
        "signalContextMenu", "signalLibraryDialog", "signalEditorDialog",
        "signalLibraryRows", "signalEditorForm", "signalBitMap",
        "signalPreview", "signalInspectorRows", "signalCanId",
        "signalSearch", "signalInspectorCount",
        "signalImportFile", "signalImportConflict", "signalImportResult",
        "signalDisplayMode", "signalChoices", "signalChoicesGroup",
        "signalOccupiedSummary", "signalExistingList",
    )
    assert set(required) <= set(page.ids)


def test_sidebar_responsiveness_and_trace_bound():
    for token in (".app-shell", ".sidebar", ".main-nav", ".trace-toolbar",
                  ".trace-actions", ".trace.table-wrap",
                  "@media(max-width: 950px)", "@media(max-width: 650px)"):
        assert token in CSS
    assert "TRACE_RENDER_LIMIT = 1000" in JS
    assert "TRACE_SCROLL_LIMIT = 3000" in JS
    assert 'id="traceVisibleCount"' in HTML


def test_version_alignment():
    assert "v0.4.0" in HTML
    assert "/static/style.css?v=0.4.0" in HTML
    assert "/static/app.js?v=0.4.0" in HTML


def test_signal_editor_actions_and_menu_exist():
    for token in ("openSignalLibrary()", "newSignalFromContext()",
                  'id="signalByteOrder"', 'id="signalBitLength"',
                  'id="signalStartBit"', 'id="signalValueType"',
                  'id="signalFactor"', 'id="signalOffset"'):
        assert token in HTML
    for token in ("function initializeSignalUI()", "function startSignalEditor(",
                  "function saveSignalDefinition(", "function decodedSignalSummary(",
                  "function updateSignalBitMap("):
        assert token in JS


def test_expanded_signal_layout_and_search():
    for token in (".trace-details-grid", ".trace-expand-button",
                  ".signal-inspector-controls", "max-height: 352px"):
        assert token in CSS
    assert "data-trace-collapse" in JS
    assert "function toggleTraceSignalDetails(" in JS
    assert 'id="signalSearch"' in HTML



def test_enum_import_and_occupied_map_controls():
    for token in ('id="signalImportFile"', 'id="signalDisplayMode"',
                  'id="signalChoices"', 'id="signalExistingList"',
                  'id="signalOccupiedSummary"', 'id="signalChoicesHelp"'):
        assert token in HTML
    for token in ("function importSignalLibraryFile(", "function parseChoiceLines(",
                  "function occupiedSignalBits(", "function updateSignalDisplayMode("):
        assert token in JS
    for token in (".signal-byte-bit.is-defined", ".signal-byte-bit.is-overlap",
                  ".signal-existing-chip", ".signal-choice-group"):
        assert token in CSS
