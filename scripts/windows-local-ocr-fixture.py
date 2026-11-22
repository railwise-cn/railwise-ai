import json
import platform
import sys
from importlib.metadata import version
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def create_scan(output, font_path):
    sample_lines = [
        ["工程测量与监测", "RAILWISE SCAN CHECK 41279"],
        ["沉降监测记录", "STATION TEST 705193"],
    ]
    font = ImageFont.truetype(str(font_path), 62)
    pages = []
    for lines in sample_lines:
        image = Image.new("RGB", (1300, 650), "white")
        draw = ImageDraw.Draw(image)
        for index, line in enumerate(lines):
            draw.text((100, 140 + index * 160), line, font=font, fill="black")
        pages.append(image)
    pages[0].save(output, "PDF", resolution=144, save_all=True, append_images=pages[1:])
    print(json.dumps(sample_lines))


def recognize_scan(source):
    import pypdfium2 as pdfium
    from rapidocr_onnxruntime import RapidOCR

    engine = RapidOCR(intra_op_num_threads=2, inter_op_num_threads=1)
    document = pdfium.PdfDocument(str(source))
    pages = []
    for page in document:
        if page.get_textpage().get_text_bounded().strip():
            raise ValueError("The uploaded scan unexpectedly contains selectable text")
        bitmap = page.render(scale=2.5).to_numpy()
        result, _ = engine(bitmap, use_cls=False)
        if not result:
            raise ValueError("OCR returned no detected text")
        pages.append("\n".join(line[1] for line in result))
    print(json.dumps({
        "platform": platform.system(),
        "architecture": platform.machine(),
        "engine": f"RapidOCR {version('rapidocr-onnxruntime')}",
        "onnxRuntime": version("onnxruntime"),
        "pages": pages,
        "imageOnly": True,
    }))


if __name__ == "__main__":
    if sys.argv[1] == "create":
        create_scan(Path(sys.argv[2]), Path(sys.argv[3]))
    elif sys.argv[1] == "recognize":
        recognize_scan(Path(sys.argv[2]))
    else:
        raise SystemExit("Unknown OCR fixture operation")
