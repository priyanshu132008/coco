import React, { forwardRef, useImperativeHandle, useRef } from 'react'
import { View } from 'react-native'
import WebView, { type WebViewMessageEvent } from 'react-native-webview'

export interface DomRect {
  tag: string
  id?: string
  text: string
  x: number
  y: number
  width: number
  height: number
}

export interface AgentWebViewHandle {
  /** Inject the DOM+rect collector into the active page and post the result back over the bridge. */
  collectDom: () => void
  /** Dispatch a synthesized click at viewport coordinates, from a model action. */
  dispatchClick: (x: number, y: number) => void
  /** Type `text` into the k-th collected input/textarea (index from the fresh selector order). */
  typeInto: (index: number, text: string) => void
}

const COLLECT = `(function(){
  window.__oiClick = function(x, y) {
    var el = document.elementFromPoint(x, y);
    if (el) {
      ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y }));
      });
    }
  };
  window.__oiType = function(idx, text) {
    var el = document.querySelectorAll('input, textarea, select')[idx];
    if (!el) return;
    var setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype, 'value');
    if (setter && setter.set) setter.set.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  var elements = Array.prototype.map.call(document.querySelectorAll('a, button, input, select, textarea, [role=button], [role=link]'), function(el) {
    var r = el.getBoundingClientRect();
    return { tag: el.tagName.toLowerCase(), id: el.id || undefined, text: (el.innerText || el.value || '').slice(0, 60),
             x: r.x, y: r.y, width: r.width, height: r.height };
  }).filter(function(e) { return e.width > 0 && e.height > 0; });
  window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dom', elements: elements }));
})(); true;`

interface AgentWebViewProps {
  uri: string
  onDom?: (elements: DomRect[]) => void
  style?: object
}

/** Embedded live web panel: collects interactive DOM + rects over the RN WebView bridge, executes model click/type back. */
export const AgentWebView = forwardRef<AgentWebViewHandle, AgentWebViewProps>(function AgentWebView(props, ref) {
  const webRef = useRef<WebView>(null)

  useImperativeHandle(ref, () => ({
    collectDom: () => webRef.current?.injectJavaScript(COLLECT),
    dispatchClick: (x: number, y: number) => webRef.current?.injectJavaScript(`window.__oiClick(${x},${y}); true;`),
    typeInto: (index: number, text: string) =>
      webRef.current?.injectJavaScript(`window.__oiType(${index},${JSON.stringify(text)}); true;`),
  }))

  const onMessage = (e: WebViewMessageEvent): void => {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type: string; elements?: DomRect[] }
      if (msg.type === 'dom' && msg.elements) props.onDom?.(msg.elements)
    } catch {
      // non-agent message from the page — ignore
    }
  }

  return (
    <View style={[{ flex: 1 }, props.style]}>
      <WebView
        ref={webRef}
        source={{ uri: props.uri }}
        javaScriptEnabled
        domStorageEnabled
        onMessage={onMessage}
        onNavigationStateChange={() => webRef.current?.injectJavaScript(COLLECT)}
        injectedJavaScript={COLLECT}
        style={{ flex: 1 }}
      />
    </View>
  )
})