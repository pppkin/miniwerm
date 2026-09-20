export function isLinkActivationModifier(event, navigator) {
    return navigator.platform.startsWith("Mac") ? event.metaKey : event.ctrlKey;
}
