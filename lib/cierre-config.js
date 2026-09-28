// Opciones del form "Registro de cierre" (registro-de-cierre.html → api/cierre.js).
// Única fuente de verdad: la página las pide por GET a /api/cierre y el endpoint valida contra
// estas mismas listas. Para sumar un closer o un programa se edita acá y listo.

module.exports = {
  programas: ['Avanzado', 'Normal', 'Bajo'],
  closers: ['Agos', 'Abad', 'Agustín', 'Zoe'],
  modalidades: ['PIF', 'Cuotas', 'Seña'],
  // "Meses de asesoría": de 1 a 12 (el Sheet de ejemplo usa "3 meses", "4 meses").
  mesesMax: 12,
  // Cuotas posibles después de la entrada (el Sheet tiene columnas C1, C2 y C3).
  cuotasMax: 3
};
