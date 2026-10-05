// Edge case: an AI-generated React artifact (.jsx) — ES module imports, lucide-react icons, Tailwind classes,
// non-standard field names (spanish / english), cards nested inside a categories object,
// accented characters, and a duplicate card that appears in two categories.
import React, { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, RotateCcw, Shuffle } from 'lucide-react';

const vocabulary = {
  animals: [
    { spanish: 'el perro', english: 'the dog' },
    { spanish: 'el gato', english: 'the cat' },
    { spanish: 'el pájaro', english: 'the bird' },
    { spanish: 'la tortuga', english: 'the turtle' },
  ],
  food: [
    { spanish: 'la manzana', english: 'the apple' },
    { spanish: 'el pan', english: 'the bread' },
    { spanish: 'el queso', english: 'the cheese' },
    { spanish: 'la piña', english: 'the pineapple' },
  ],
  phrases: [
    { spanish: '¿Cómo estás?', english: 'How are you?' },
    { spanish: 'Mucho gusto', english: 'Nice to meet you' },
    { spanish: '¿Dónde está el baño?', english: 'Where is the bathroom?' },
    { spanish: 'el perro', english: 'the dog' },
  ],
};

export default function SpanishFlashcards() {
  const [category, setCategory] = useState('animals');
  const [index, setIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [order, setOrder] = useState(null);

  const cards = useMemo(() => {
    const list = vocabulary[category];
    return order ? order.map(i => list[i]) : list;
  }, [category, order]);

  const card = cards[index];

  const go = (delta) => {
    setFlipped(false);
    setIndex((index + delta + cards.length) % cards.length);
  };

  const shuffle = () => {
    const idx = cards.map((_, i) => i).sort(() => Math.random() - 0.5);
    setOrder(idx);
    setIndex(0);
    setFlipped(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-orange-100 to-rose-200 flex flex-col items-center justify-center p-6">
      <h1 className="text-3xl font-bold text-rose-800 mb-2">🇪🇸 Spanish Vocabulary</h1>
      <div className="flex gap-2 mb-6">
        {Object.keys(vocabulary).map(cat => (
          <button
            key={cat}
            onClick={() => { setCategory(cat); setIndex(0); setFlipped(false); setOrder(null); }}
            className={`px-4 py-1 rounded-full capitalize ${cat === category ? 'bg-rose-600 text-white' : 'bg-white text-rose-700'}`}
          >
            {cat}
          </button>
        ))}
      </div>

      <div
        onClick={() => setFlipped(!flipped)}
        className="w-full max-w-md h-56 bg-white rounded-2xl shadow-xl flex items-center justify-center cursor-pointer select-none transition hover:scale-[1.02]"
      >
        <span className={`text-3xl font-semibold ${flipped ? 'text-orange-600' : 'text-rose-800'}`}>
          {flipped ? card.english : card.spanish}
        </span>
      </div>

      <div className="flex items-center gap-4 mt-6">
        <button onClick={() => go(-1)} className="p-2 rounded-full bg-white shadow"><ChevronLeft /></button>
        <span className="text-rose-800 font-medium">{index + 1} / {cards.length}</span>
        <button onClick={() => go(1)} className="p-2 rounded-full bg-white shadow"><ChevronRight /></button>
        <button onClick={() => setFlipped(false)} className="p-2 rounded-full bg-white shadow"><RotateCcw size={20} /></button>
        <button onClick={shuffle} className="p-2 rounded-full bg-white shadow"><Shuffle size={20} /></button>
      </div>
    </div>
  );
}
