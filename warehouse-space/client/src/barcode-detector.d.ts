// Ambient types for the Barcode Detection API (not yet in TypeScript's
// DOM lib). Supported natively on Chrome/Android and some other browsers;
// where it is missing the app falls back to ZXing (see BarcodeScanner.tsx).
// https://developer.mozilla.org/en-US/docs/Web/API/Barcode_Detection_API

interface DetectedBarcode {
  rawValue: string;
  format: string;
  cornerPoints: Array<{ x: number; y: number }>;
  boundingBox: DOMRectReadOnly;
}

interface BarcodeDetectorOptions {
  formats?: string[];
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
  static getSupportedFormats(): Promise<string[]>;
}

interface Window {
  BarcodeDetector?: typeof BarcodeDetector;
}
