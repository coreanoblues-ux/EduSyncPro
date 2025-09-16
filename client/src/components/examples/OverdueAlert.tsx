import OverdueAlert from '../OverdueAlert';

export default function OverdueAlertExample() {
  // todo: remove mock functionality
  const handleViewOverdues = () => {
    console.log('View overdues clicked');
  };

  return (
    <div className="max-w-2xl">
      <OverdueAlert overdueCount={5} onViewOverdues={handleViewOverdues} />
    </div>
  );
}